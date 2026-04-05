from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
import re

from .app_server import CodexAppServerClient
from .events import EventBroker
from .settings import Settings
from .vault import VaultManager
from .web_state import AgentRecord, JobRecord, RunRecord, WebStateStore, utc_now_text


class AgentRuntime:
    def __init__(
        self,
        settings: Settings,
        store: WebStateStore,
        vault: VaultManager,
        events: EventBroker,
    ) -> None:
        self._settings = settings
        self._store = store
        self._vault = vault
        self._events = events
        self._client = CodexAppServerClient(settings)
        self._started = False
        self._start_lock = asyncio.Lock()
        self._agent_locks: dict[str, asyncio.Lock] = {}
        self._running_agents: set[str] = set()
        self._tasks: set[asyncio.Task[None]] = set()

    async def start(self) -> None:
        async with self._start_lock:
            if self._started:
                return
            await self._client.start()
            self._started = True

    async def close(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        await self._client.close()

    async def read_account(self) -> dict[str, object]:
        await self.start()
        return await self._client.read_account()

    async def login_chatgpt(self) -> dict[str, object]:
        await self.start()
        return await self._client.login_chatgpt()

    async def logout(self) -> None:
        await self.start()
        await self._client.logout()

    def is_agent_running(self, agent_id: str) -> bool:
        return agent_id in self._running_agents

    async def launch_manual_run(self, agent_id: str, prompt: str) -> RunRecord:
        agent = self._store.get_agent(agent_id)
        if not agent.enabled:
            raise ValueError("Enable the agent before running it.")
        if self.is_agent_running(agent.id):
            raise ValueError("This agent is already running.")
        output_note_path = self._build_output_note_path(agent, job=None)
        run = self._store.create_run(
            agent_id=agent.id,
            job_id=None,
            trigger="manual",
            output_note_path=output_note_path,
        )
        await self._events.publish("run.queued", self._run_payload(run))
        self._start_background_run(
            agent=agent,
            job=None,
            run=run,
            task_prompt=prompt.strip(),
            output_note_path=output_note_path,
        )
        return self._store.get_run(run.id)

    async def launch_job_run(self, job_id: str, *, trigger: str = "manual") -> RunRecord:
        job = self._store.get_job(job_id)
        agent = self._store.get_agent(job.agent_id)
        if not agent.enabled or not job.enabled:
            raise ValueError("Enable both the agent and the job before running it.")
        if self.is_agent_running(agent.id):
            raise ValueError("This agent is already running.")
        output_note_path = self._build_output_note_path(agent, job=job)
        run = self._store.create_run(
            agent_id=agent.id,
            job_id=job.id,
            trigger=trigger,
            output_note_path=output_note_path,
        )
        await self._events.publish("run.queued", self._run_payload(run))
        self._start_background_run(
            agent=agent,
            job=job,
            run=run,
            task_prompt=job.prompt,
            output_note_path=output_note_path,
        )
        return self._store.get_run(run.id)

    def _start_background_run(
        self,
        *,
        agent: AgentRecord,
        job: JobRecord | None,
        run: RunRecord,
        task_prompt: str,
        output_note_path: str,
    ) -> None:
        self._running_agents.add(agent.id)
        task = asyncio.create_task(
            self._execute_run(
                agent=agent,
                job=job,
                run=run,
                task_prompt=task_prompt,
                output_note_path=output_note_path,
            )
        )
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _execute_run(
        self,
        *,
        agent: AgentRecord,
        job: JobRecord | None,
        run: RunRecord,
        task_prompt: str,
        output_note_path: str,
    ) -> None:
        lock = self._agent_locks.setdefault(agent.id, asyncio.Lock())
        try:
            async with lock:
                await self.start()
                self._store.mark_run_running(run.id)
                running_run = self._store.get_run(run.id)
                await self._events.publish("run.started", self._run_payload(running_run))

                scope_abs = self._vault.resolve_dir(agent.scope_path)
                self._vault.ensure_note(
                    output_note_path,
                    title=self._note_title(agent, job),
                    body=self._note_preamble(agent, job),
                )
                before = self._vault.snapshot_scope(agent.scope_path)
                thread_id = await self._ensure_thread(agent, scope_abs)
                final_text = await self._client.run_turn(
                    thread_id,
                    self._turn_prompt(agent, job, task_prompt, output_note_path),
                    effort=agent.reasoning_effort,
                    cwd=str(scope_abs),
                    model=agent.model,
                    approval_policy=agent.approval_policy,
                    sandbox_mode=agent.sandbox_mode,
                )
                self._vault.sync_index(force=True)
                after = self._vault.snapshot_scope(agent.scope_path)
                touched = self._vault.diff_snapshots(before, after)
                completed = self._store.finish_run(
                    run.id,
                    status="succeeded",
                    final_text=final_text,
                    error_text=None,
                    touched_paths=touched,
                )
                if job and job.schedule_type == "interval" and job.interval_minutes:
                    next_run_at = (datetime.now(timezone.utc) + timedelta(minutes=job.interval_minutes)).isoformat()
                    self._store.set_job_run_state(
                        job.id,
                        last_run_at=completed.finished_at or utc_now_text(),
                        next_run_at=next_run_at,
                    )
                await self._events.publish("run.completed", self._run_payload(completed))
                await self._events.publish("vault.changed", {"paths": touched})
        except Exception as exc:
            failed = self._store.finish_run(
                run.id,
                status="failed",
                final_text=None,
                error_text=str(exc),
                touched_paths=[],
            )
            if job and job.schedule_type == "interval" and job.interval_minutes:
                next_run_at = (datetime.now(timezone.utc) + timedelta(minutes=job.interval_minutes)).isoformat()
                self._store.set_job_run_state(
                    job.id,
                    last_run_at=failed.finished_at or utc_now_text(),
                    next_run_at=next_run_at,
                )
            await self._events.publish("run.completed", self._run_payload(failed))
        finally:
            self._running_agents.discard(agent.id)

    async def _ensure_thread(self, agent: AgentRecord, scope_abs: Path) -> str:
        base_instructions = self._thread_base_instructions(agent)
        developer_instructions = self._thread_developer_instructions(agent)
        if agent.thread_id:
            await self._client.resume_thread(
                agent.thread_id,
                cwd=str(scope_abs),
                model=agent.model,
                approval_policy=agent.approval_policy,
                sandbox_mode=agent.sandbox_mode,
                base_instructions=base_instructions,
                developer_instructions=developer_instructions,
            )
            return agent.thread_id

        result = await self._client.start_thread(
            cwd=str(scope_abs),
            model=agent.model,
            approval_policy=agent.approval_policy,
            sandbox_mode=agent.sandbox_mode,
            base_instructions=base_instructions,
            developer_instructions=developer_instructions,
        )
        thread_id = result["thread"]["id"]
        await self._client.set_thread_name(thread_id, agent.name)
        self._store.set_agent_thread_id(agent.id, thread_id)
        return thread_id

    def _thread_base_instructions(self, agent: AgentRecord) -> str:
        parts = [
            self._settings.codex_base_instructions or "",
            f"You are {agent.name}, an AI agent working inside a local knowledge base.",
            "You should prefer durable note edits over chat-only answers whenever possible.",
            "Stay focused on the user's vault and the assigned scope.",
            f"Standing role:\n{agent.prompt.strip()}",
        ]
        return "\n\n".join(part.strip() for part in parts if part and part.strip())

    def _thread_developer_instructions(self, agent: AgentRecord) -> str:
        parts = [
            self._settings.codex_developer_instructions or "",
            "Work only inside the assigned scope path unless the task explicitly says otherwise.",
            "Avoid destructive edits, preserve existing tone and structure, and keep markdown readable.",
            "If you are uncertain, leave clear notes in the output document rather than making broad speculative edits.",
            f"Scope path: {agent.scope_path}",
            f"Output directory: {agent.output_dir}",
        ]
        return "\n\n".join(part.strip() for part in parts if part and part.strip())

    def _turn_prompt(
        self,
        agent: AgentRecord,
        job: JobRecord | None,
        task_prompt: str,
        output_note_path: str,
    ) -> str:
        task_text = task_prompt.strip() or "Review the current scope and capture the most useful updates."
        lines = [
            f"Run trigger: {'scheduled job' if job else 'manual run'}",
            f"Scope path: {agent.scope_path}",
            f"Primary output note: {output_note_path}",
            "",
            "Task:",
            task_text,
            "",
            "Instructions:",
            f"1. Read the relevant files inside {agent.scope_path}.",
            f"2. Update or create {output_note_path} as the main durable artifact for this run.",
            "3. Keep any other edits focused, minimal, and clearly useful.",
            "4. Finish with a short summary of what changed and any follow-up suggestions.",
        ]
        if job is not None:
            lines.insert(1, f"Job name: {job.name}")
        return "\n".join(lines)

    def _build_output_note_path(self, agent: AgentRecord, job: JobRecord | None) -> str:
        timestamp = datetime.now().astimezone()
        if job is None:
            filename = f"{timestamp.strftime('%Y-%m-%d-%H%M%S')}-{self._slug(agent.name)}-manual.md"
        else:
            filename = f"{timestamp.strftime('%Y-%m-%d')}-{self._slug(job.name)}.md"
        return f"{agent.output_dir.rstrip('/')}/{filename}".lstrip("/")

    def _note_title(self, agent: AgentRecord, job: JobRecord | None) -> str:
        if job is None:
            return f"{agent.name} Manual Run"
        return f"{agent.name} - {job.name}"

    def _note_preamble(self, agent: AgentRecord, job: JobRecord | None) -> str:
        lines = [
            f"_Agent_: {agent.name}",
            f"_Scope_: `{agent.scope_path}`",
            f"_Created_: {datetime.now().astimezone().isoformat(timespec='seconds')}",
        ]
        if job is not None:
            lines.insert(1, f"_Job_: {job.name}")
        return "\n".join(lines) + "\n\n## Notes\n\n"

    def _run_payload(self, run: RunRecord) -> dict[str, object]:
        return {
            "id": run.id,
            "agentId": run.agent_id,
            "jobId": run.job_id,
            "trigger": run.trigger,
            "status": run.status,
            "startedAt": run.started_at,
            "finishedAt": run.finished_at,
            "finalText": run.final_text,
            "errorText": run.error_text,
            "touchedPaths": run.touched_paths,
            "outputNotePath": run.output_note_path,
        }

    def _slug(self, text: str) -> str:
        normalized = re.sub(r"[^A-Za-z0-9]+", "-", text.strip().lower()).strip("-")
        return normalized or "run"


class JobScheduler:
    def __init__(
        self,
        store: WebStateStore,
        runtime: AgentRuntime,
        poll_seconds: int,
    ) -> None:
        self._store = store
        self._runtime = runtime
        self._poll_seconds = poll_seconds
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if self._task is not None:
            return
        self._task = asyncio.create_task(self._loop())

    async def close(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)
        self._task = None

    async def _loop(self) -> None:
        while True:
            now_text = utc_now_text()
            for job in self._store.list_due_jobs(now_text):
                if self._runtime.is_agent_running(job.agent_id):
                    continue
                try:
                    await self._runtime.launch_job_run(job.id, trigger="schedule")
                except ValueError:
                    continue
            await asyncio.sleep(self._poll_seconds)
