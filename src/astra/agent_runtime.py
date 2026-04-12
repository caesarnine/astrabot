from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import logging
from pathlib import Path

from .app_server import CodexAppServerClient
from .events import EventBroker
from .scheduling import next_job_run_at
from .settings import Settings
from .vault import VaultManager
from .web_state import ActivityRecord, AgentRecord, JobRecord, RunRecord, WebStateStore, utc_now_text

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class PendingAttention:
    activity_id: str
    agent_id: str
    run_id: str
    thread_id: str
    turn_id: str
    response_mode: str
    questions: list[dict[str, object]]
    future: asyncio.Future[dict[str, object]]


class AgentRuntime:
    _CLARIFICATION_TOOL_NAME = "request_clarification"

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
        self._last_account: dict[str, object] | None = None
        self._pending_attentions: dict[str, PendingAttention] = {}

    async def start(self) -> None:
        async with self._start_lock:
            if self._started:
                return
            await self._client.start()
            self._started = True

    async def close(self) -> None:
        for pending in list(self._pending_attentions.values()):
            if not pending.future.done():
                pending.future.cancel()
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        await self._client.close()

    async def read_account(self) -> dict[str, object]:
        await self.start()
        result = await self._client.read_account()
        self._last_account = result
        return result

    async def login_chatgpt(self) -> dict[str, object]:
        await self.start()
        return await self._client.login_chatgpt()

    async def logout(self) -> None:
        await self.start()
        await self._client.logout()

    def is_agent_running(self, agent_id: str) -> bool:
        return agent_id in self._running_agents

    def last_account(self) -> dict[str, object] | None:
        return self._last_account

    async def launch_manual_run(self, agent_id: str, prompt: str) -> RunRecord:
        agent = self._store.get_agent(agent_id)
        if not agent.enabled:
            raise ValueError("Enable the agent before running it.")
        if self.is_agent_running(agent.id):
            raise ValueError("This agent is already running.")
        run = self._store.create_run(
            agent_id=agent.id,
            job_id=None,
            trigger="manual",
            thread_id=agent.thread_id,
        )
        await self._events.publish("run.queued", self._run_payload(run))
        self._start_background_run(
            agent=agent,
            job=None,
            run=run,
            task_prompt=prompt.strip(),
            trigger_context={},
        )
        return self._store.get_run(run.id)

    async def launch_job_run(
        self,
        job_id: str,
        *,
        trigger: str = "manual",
        trigger_context: dict[str, object] | None = None,
    ) -> RunRecord:
        job = self._store.get_job(job_id)
        agent = self._store.get_agent(job.agent_id)
        if not agent.enabled or not job.enabled:
            raise ValueError("Enable both the agent and the job before running it.")
        if self.is_agent_running(agent.id):
            raise ValueError("This agent is already running.")
        run = self._store.create_run(
            agent_id=agent.id,
            job_id=job.id,
            trigger=trigger,
            thread_id=agent.thread_id,
        )
        await self._events.publish("run.queued", self._run_payload(run))
        self._start_background_run(
            agent=agent,
            job=job,
            run=run,
            task_prompt=job.prompt,
            trigger_context=trigger_context or {},
        )
        return self._store.get_run(run.id)

    async def steer_agent(self, agent_id: str, prompt: str) -> None:
        agent = self._store.get_agent(agent_id)
        if not agent.thread_id or not agent.active_turn_id:
            raise ValueError("This agent is not currently waiting on an active turn.")
        await self.start()
        await self._client.steer_turn(agent.thread_id, agent.active_turn_id, prompt.strip())

    async def reply_to_attention(self, activity_id: str, text: str) -> ActivityRecord:
        activity = self._store.get_activity(activity_id)
        if activity.kind != "attention":
            raise ValueError("This activity item is not waiting for input.")
        pending = self._pending_attentions.get(activity_id)
        reply_text = text.strip()
        if not reply_text:
            raise ValueError("Reply text cannot be empty.")

        updated = self._store.update_activity(
            activity_id,
            status="replied",
            metadata={
                **activity.metadata,
                "replyText": reply_text,
                "repliedAt": utc_now_text(),
            },
        )
        await self._events.publish("attention.updated", self._activity_payload(updated))

        if pending is not None and not pending.future.done():
            pending.future.set_result(self._pending_attention_response(pending, reply_text))
            return updated

        agent = self._store.get_agent(activity.agent_id)
        if agent.thread_id:
            if agent.active_turn_id:
                await self._client.steer_turn(agent.thread_id, agent.active_turn_id, self._follow_up_prompt(activity, reply_text))
            elif not self.is_agent_running(agent.id):
                await self.launch_manual_run(
                    agent.id,
                    self._follow_up_prompt(activity, reply_text),
                )
        return updated

    async def dismiss_attention(self, activity_id: str) -> ActivityRecord:
        activity = self._store.get_activity(activity_id)
        if activity.kind != "attention":
            raise ValueError("This activity item is not waiting for input.")
        dismissal_text = "User dismissed the question and asked you to proceed with your best judgment."
        updated = self._store.update_activity(
            activity_id,
            status="dismissed",
            metadata={
                **activity.metadata,
                "dismissedAt": utc_now_text(),
            },
        )
        await self._events.publish("attention.updated", self._activity_payload(updated))

        pending = self._pending_attentions.get(activity_id)
        if pending is not None and not pending.future.done():
            pending.future.set_result(self._pending_attention_response(pending, dismissal_text))
        return updated

    def _start_background_run(
        self,
        *,
        agent: AgentRecord,
        job: JobRecord | None,
        run: RunRecord,
        task_prompt: str,
        trigger_context: dict[str, object],
    ) -> None:
        self._running_agents.add(agent.id)
        task = asyncio.create_task(
            self._execute_run(
                agent=agent,
                job=job,
                run=run,
                task_prompt=task_prompt,
                trigger_context=trigger_context,
            )
        )
        self._tasks.add(task)
        task.add_done_callback(self._handle_background_task_done)

    async def _execute_run(
        self,
        *,
        agent: AgentRecord,
        job: JobRecord | None,
        run: RunRecord,
        task_prompt: str,
        trigger_context: dict[str, object],
    ) -> None:
        lock = self._agent_locks.setdefault(agent.id, asyncio.Lock())
        before: dict[str, int] | None = None
        try:
            async with lock:
                await self.start()
                running_run = self._store.mark_run_running(run.id)
                await self._events.publish("run.started", self._run_payload(running_run))

                scope_abs = self._vault.resolve_dir(agent.scope_path)
                before = self._vault.snapshot_scope(agent.scope_path)
                thread_id = await self._ensure_thread(agent, scope_abs)
                prompt = self._turn_prompt(agent, job, task_prompt, trigger_context)

                async def on_event(event: dict[str, object]) -> dict[str, object] | None:
                    kind = str(event["kind"])
                    if kind == "turn_started":
                        started_run = self._store.set_run_turn(
                            run.id,
                            thread_id=thread_id,
                            turn_id=str(event["turnId"]),
                        )
                        await self._events.publish("run.started", self._run_payload(started_run))
                        return None

                    if kind != "server_request":
                        return None

                    method = str(event["method"])
                    params = event["params"]
                    assert isinstance(params, dict)

                    if method == "item/tool/requestUserInput":
                        questions = params.get("questions") or []
                        activity = self._store.create_activity(
                            agent_id=agent.id,
                            job_id=job.id if job else None,
                            run_id=run.id,
                            thread_id=str(event["threadId"]),
                            turn_id=str(event["turnId"]),
                            kind="attention",
                            status="pending",
                            title=self._attention_title(agent, questions),
                            body=self._attention_body(questions),
                            primary_path=self._attention_primary_path(trigger_context),
                            paths=self._attention_paths(trigger_context),
                            metadata={
                                "questions": questions,
                                "requestId": event["requestId"],
                                "jobName": job.name if job else None,
                                "requestKind": "native_request_user_input",
                            },
                        )
                        return await self._await_attention_response(
                            activity,
                            response_mode="native_request_user_input",
                            questions=[question for question in questions if isinstance(question, dict)],
                        )

                    if method != "item/tool/call":
                        return None

                    tool_name = str(params.get("tool") or "").strip()
                    if tool_name != self._CLARIFICATION_TOOL_NAME:
                        return None

                    arguments = self._clarification_arguments(params.get("arguments"))
                    question = str(arguments.get("question") or "").strip()
                    if not question:
                        question = "What clarification do you need to continue?"
                    activity = self._store.create_activity(
                        agent_id=agent.id,
                        job_id=job.id if job else None,
                        run_id=run.id,
                        thread_id=str(event["threadId"]),
                        turn_id=str(event["turnId"]),
                        kind="attention",
                        status="pending",
                        title=f"{agent.name} needs input",
                        body=self._clarification_body(question, arguments),
                        primary_path=self._clarification_primary_path(arguments, trigger_context),
                        paths=self._attention_paths(trigger_context),
                        metadata={
                            "requestId": event["requestId"],
                            "callId": params.get("callId"),
                            "toolName": tool_name,
                            "toolArguments": arguments,
                            "jobName": job.name if job else None,
                            "requestKind": "dynamic_tool_call",
                        },
                    )
                    return await self._await_attention_response(
                        activity,
                        response_mode="dynamic_tool_call",
                        questions=[],
                    )

                result = await self._client.run_turn_streamed(
                    thread_id,
                    prompt,
                    effort=agent.reasoning_effort,
                    cwd=str(scope_abs),
                    model=agent.model,
                    approval_policy=agent.approval_policy,
                    sandbox_mode=agent.sandbox_mode,
                    on_event=on_event,
                )

                self._vault.sync_index(force=True)
                after = self._vault.snapshot_scope(agent.scope_path)
                touched = self._vault.diff_snapshots(before, after)
                completed = self._store.finish_run(
                    run.id,
                    status="succeeded",
                    summary_text=result.text,
                    error_text=None,
                    touched_paths=touched,
                )
                if job is not None:
                    next_run_at = next_job_run_at(job)
                    self._store.set_job_run_state(
                        job.id,
                        last_run_at=completed.finished_at or utc_now_text(),
                        next_run_at=next_run_at,
                    )
                activity = self._create_completion_activity(agent, job, completed, trigger_context)
                await self._events.publish("run.completed", self._run_payload(completed))
                await self._events.publish("activity.created", self._activity_payload(activity))
                if activity.kind == "attention" and activity.status == "pending":
                    await self._events.publish("attention.updated", self._activity_payload(activity))
                if touched:
                    await self._events.publish(
                        "vault.changed",
                        {
                            "paths": touched,
                            "agentId": agent.id,
                            "runId": completed.id,
                            "activityId": activity.id,
                        },
                    )
        except asyncio.CancelledError:
            touched = self._recover_touched_paths(agent.scope_path, before)
            cancelled = self._store.finish_run(
                run.id,
                status="failed",
                summary_text=None,
                error_text="Run interrupted while Astra was shutting down.",
                touched_paths=touched,
            )
            self._expire_pending_attentions(run.id)
            if job is not None:
                self._store.set_job_run_state(
                    job.id,
                    last_run_at=cancelled.finished_at or utc_now_text(),
                    next_run_at=next_job_run_at(job),
                )
            failure_activity = self._store.create_activity(
                agent_id=agent.id,
                job_id=job.id if job else None,
                run_id=run.id,
                thread_id=cancelled.thread_id,
                turn_id=cancelled.turn_id,
                kind="notification",
                status="failed",
                title=f"{agent.name} did not finish",
                body=cancelled.error_text,
                paths=touched,
                primary_path=touched[0] if touched else None,
                metadata={"trigger": cancelled.trigger},
            )
            await self._events.publish("run.completed", self._run_payload(cancelled))
            await self._events.publish("activity.created", self._activity_payload(failure_activity))
            if touched:
                await self._events.publish(
                    "vault.changed",
                    {
                        "paths": touched,
                        "agentId": agent.id,
                        "runId": cancelled.id,
                        "activityId": failure_activity.id,
                    },
                )
            raise
        except Exception as exc:
            touched = self._recover_touched_paths(agent.scope_path, before)
            failed = self._store.finish_run(
                run.id,
                status="failed",
                summary_text=None,
                error_text=str(exc),
                touched_paths=touched,
            )
            self._expire_pending_attentions(run.id)
            if job is not None:
                self._store.set_job_run_state(
                    job.id,
                    last_run_at=failed.finished_at or utc_now_text(),
                    next_run_at=next_job_run_at(job),
                )
            failure_activity = self._store.create_activity(
                agent_id=agent.id,
                job_id=job.id if job else None,
                run_id=run.id,
                thread_id=failed.thread_id,
                turn_id=failed.turn_id,
                kind="notification",
                status="failed",
                title=f"{agent.name} hit an error",
                body=str(exc),
                paths=touched,
                primary_path=touched[0] if touched else None,
                metadata={"trigger": failed.trigger},
            )
            await self._events.publish("run.completed", self._run_payload(failed))
            await self._events.publish("activity.created", self._activity_payload(failure_activity))
            if touched:
                await self._events.publish(
                    "vault.changed",
                    {
                        "paths": touched,
                        "agentId": agent.id,
                        "runId": failed.id,
                        "activityId": failure_activity.id,
                    },
                )
        finally:
            self._running_agents.discard(agent.id)

    def _create_completion_activity(
        self,
        agent: AgentRecord,
        job: JobRecord | None,
        run: RunRecord,
        trigger_context: dict[str, object],
    ) -> ActivityRecord:
        touched = run.touched_paths
        if touched:
            title = self._artifact_title(agent, touched)
            kind = "artifact"
            status = "succeeded"
        elif self._looks_like_attention_request(run.summary_text):
            title = f"{agent.name} needs input"
            kind = "attention"
            status = "pending"
        else:
            title = self._notification_title(agent, job, run.trigger)
            kind = "notification"
            status = "succeeded"
        return self._store.create_activity(
            agent_id=agent.id,
            job_id=job.id if job else None,
            run_id=run.id,
            thread_id=run.thread_id,
            turn_id=run.turn_id,
            kind=kind,
            status=status,
            title=title,
            body=run.summary_text,
            primary_path=touched[0] if touched else self._attention_primary_path(trigger_context),
            paths=touched,
            metadata={
                "trigger": run.trigger,
                "jobName": job.name if job else None,
                "changedPaths": trigger_context.get("changedPaths", []),
                "fallbackAttention": kind == "attention" and status == "pending",
            },
        )

    def _looks_like_attention_request(self, summary_text: str | None) -> bool:
        if not summary_text:
            return False
        lines = [line.strip() for line in summary_text.splitlines() if line.strip()]
        if not lines:
            return False
        if not lines[-1].endswith("?"):
            return False
        if len(summary_text) > 600:
            return False
        lowered = summary_text.lower()
        markers = (
            "what ",
            "which ",
            "when ",
            "where ",
            "who ",
            "would you",
            "could you",
            "do you",
            "should i",
            "please confirm",
        )
        return any(marker in lowered for marker in markers)

    def _recover_touched_paths(
        self,
        scope_path: str,
        before: dict[str, int] | None,
    ) -> list[str]:
        if before is None:
            return []

        try:
            self._vault.sync_index(force=True)
            after = self._vault.snapshot_scope(scope_path)
            return self._vault.diff_snapshots(before, after)
        except Exception:
            return []

    def _expire_pending_attentions(self, run_id: str) -> None:
        for activity_id, pending in list(self._pending_attentions.items()):
            if pending.run_id != run_id:
                continue
            if not pending.future.done():
                pending.future.cancel()
            try:
                activity = self._store.get_activity(activity_id)
            except KeyError:
                continue
            self._store.update_activity(
                activity_id,
                status="dismissed",
                metadata={
                    **activity.metadata,
                    "dismissedAt": utc_now_text(),
                },
            )
            self._pending_attentions.pop(activity_id, None)

    def _handle_background_task_done(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            return
        if exc is not None:
            logger.exception("Agent run task crashed", exc_info=exc)

    async def _ensure_thread(self, agent: AgentRecord, scope_abs: Path) -> str:
        base_instructions = self._thread_base_instructions(agent)
        developer_instructions = self._thread_developer_instructions(agent)
        if agent.thread_id:
            if self._client.is_thread_loaded(agent.thread_id):
                return agent.thread_id
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
            dynamic_tools=self._clarification_dynamic_tools(),
        )
        thread_id = result["thread"]["id"]
        await self._client.set_thread_name(thread_id, agent.name)
        self._store.set_agent_thread_id(agent.id, thread_id)
        return thread_id

    def _thread_base_instructions(self, agent: AgentRecord) -> str:
        parts = [
            self._settings.codex_base_instructions or "",
            f"You are {agent.name}, an AI agent working inside a local knowledge base.",
            "Stay focused on the user's vault, your assigned scope, and your standing role.",
            "Prefer durable file edits when they are genuinely useful, but do not create placeholder notes just to leave an artifact.",
            "If no file changes are warranted, return a concise notification-style summary instead.",
            f"Standing role:\n{agent.prompt.strip()}",
        ]
        return "\n\n".join(part.strip() for part in parts if part and part.strip())

    def _thread_developer_instructions(self, agent: AgentRecord) -> str:
        parts = [
            self._settings.codex_developer_instructions or "",
            "Work only inside the assigned scope path unless the task explicitly says otherwise.",
            "Avoid destructive edits, preserve existing tone and structure, and keep markdown readable.",
            (
                "If you need user clarification to continue safely, use the request_clarification tool with one short clear "
                "question instead of guessing. The tool returns the user's reply as plain text. If the tool is unavailable, "
                "end your response with the question so Astra can surface it as an attention request."
            ),
            "When creating a new file is appropriate, prefer placing it inside the configured output directory.",
            f"Scope path: {agent.scope_path}",
            f"Output directory: {agent.output_dir}",
        ]
        return "\n\n".join(part.strip() for part in parts if part and part.strip())

    def _turn_prompt(
        self,
        agent: AgentRecord,
        job: JobRecord | None,
        task_prompt: str,
        trigger_context: dict[str, object],
    ) -> str:
        task_text = task_prompt.strip() or "Review the current scope and capture the most useful updates."
        lines = [
            f"Run trigger: {self._human_trigger(job, trigger_context)}",
            f"Scope path: {agent.scope_path}",
            f"Preferred output directory: {agent.output_dir}",
            "",
            "Task:",
            task_text,
        ]
        changed_paths = trigger_context.get("changedPaths")
        if isinstance(changed_paths, list) and changed_paths:
            lines.extend(
                [
                    "",
                    "Recent changed files:",
                    *[f"- {path}" for path in changed_paths if isinstance(path, str)],
                ]
            )
        lines.extend(
            [
                "",
                "Instructions:",
                f"1. Read the relevant files inside {agent.scope_path}.",
                "2. Edit existing files or create new notes only if there is meaningful durable value to add.",
                "3. If no file changes are warranted, do not create a placeholder output file.",
                "4. If you need clarification, call request_clarification with one concise question. If that tool is unavailable, end your response with the question.",
                "5. Finish with a short summary of what changed, or what you found if nothing changed.",
            ]
        )
        if job is not None:
            lines.insert(1, f"Job name: {job.name}")
        return "\n".join(lines)

    def _human_trigger(self, job: JobRecord | None, trigger_context: dict[str, object]) -> str:
        if job is None:
            return "manual request"
        if trigger_context.get("changedPaths"):
            return "file watch"
        if job.trigger_type == "cron":
            return "scheduled cron job"
        if job.trigger_type == "interval":
            return "scheduled interval job"
        return job.trigger_type

    def _attention_title(self, agent: AgentRecord, questions: object) -> str:
        if isinstance(questions, list) and questions:
            question = questions[0]
            if isinstance(question, dict):
                header = str(question.get("header") or "").strip()
                if header:
                    return f"{agent.name} needs input: {header}"
        return f"{agent.name} needs input"

    def _attention_body(self, questions: object) -> str:
        if not isinstance(questions, list) or not questions:
            return "A running agent asked for clarification."
        parts: list[str] = []
        for question in questions:
            if not isinstance(question, dict):
                continue
            prompt = str(question.get("question") or "").strip()
            if prompt:
                parts.append(prompt)
        return "\n\n".join(parts) or "A running agent asked for clarification."

    def _attention_primary_path(self, trigger_context: dict[str, object]) -> str | None:
        changed_paths = trigger_context.get("changedPaths")
        if isinstance(changed_paths, list):
            for path in changed_paths:
                if isinstance(path, str):
                    return path
        context_path = trigger_context.get("contextPath")
        return context_path if isinstance(context_path, str) else None

    def _attention_paths(self, trigger_context: dict[str, object]) -> list[str]:
        changed_paths = trigger_context.get("changedPaths")
        if not isinstance(changed_paths, list):
            return []
        return [path for path in changed_paths if isinstance(path, str)]

    async def _await_attention_response(
        self,
        activity: ActivityRecord,
        *,
        response_mode: str,
        questions: list[dict[str, object]],
    ) -> dict[str, object]:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, object]] = loop.create_future()
        self._pending_attentions[activity.id] = PendingAttention(
            activity_id=activity.id,
            agent_id=activity.agent_id,
            run_id=activity.run_id or "",
            thread_id=activity.thread_id or "",
            turn_id=activity.turn_id or "",
            response_mode=response_mode,
            questions=questions,
            future=future,
        )
        await self._events.publish("activity.created", self._activity_payload(activity))
        await self._events.publish("attention.updated", self._activity_payload(activity))
        try:
            return await future
        finally:
            self._pending_attentions.pop(activity.id, None)

    def _pending_attention_response(self, pending: PendingAttention, text: str) -> dict[str, object]:
        if pending.response_mode == "dynamic_tool_call":
            return {
                "success": True,
                "contentItems": [
                    {
                        "type": "inputText",
                        "text": text,
                    }
                ],
            }
        return self._answers_payload(pending.questions, text)

    def _clarification_dynamic_tools(self) -> list[dict[str, object]]:
        return [
            {
                "name": self._CLARIFICATION_TOOL_NAME,
                "description": (
                    "Ask the user one concise clarification question when a missing detail blocks safe progress. "
                    "Use this instead of guessing."
                ),
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["question"],
                    "properties": {
                        "question": {"type": "string"},
                        "contextPath": {"type": "string"},
                        "choices": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "canProceedWithoutAnswer": {"type": "boolean"},
                    },
                },
            }
        ]

    def _clarification_arguments(self, raw_arguments: object) -> dict[str, object]:
        if isinstance(raw_arguments, dict):
            return dict(raw_arguments)
        return {}

    def _clarification_body(self, question: str, arguments: dict[str, object]) -> str:
        parts = [question]
        choices = arguments.get("choices")
        if isinstance(choices, list):
            valid_choices = [choice.strip() for choice in choices if isinstance(choice, str) and choice.strip()]
            if valid_choices:
                parts.append("Options: " + " / ".join(valid_choices))
        return "\n\n".join(parts)

    def _clarification_primary_path(
        self,
        arguments: dict[str, object],
        trigger_context: dict[str, object],
    ) -> str | None:
        context_path = arguments.get("contextPath")
        if isinstance(context_path, str) and context_path.strip():
            return context_path.strip()
        return self._attention_primary_path(trigger_context)

    def _answers_payload(self, questions: list[dict[str, object]], text: str) -> dict[str, object]:
        answers: dict[str, object] = {}
        for question in questions:
            question_id = str(question.get("id") or "").strip()
            if not question_id:
                continue
            answers[question_id] = {"answers": [text]}
        return {"answers": answers}

    def _follow_up_prompt(self, activity: ActivityRecord, reply_text: str) -> str:
        original_question = activity.body or "The user responded to your earlier question."
        return (
            "Follow up on your earlier question.\n\n"
            f"Original question:\n{original_question}\n\n"
            f"User response:\n{reply_text}\n\n"
            "Proceed using this clarification, update the vault if needed, and summarize the outcome."
        )

    def _artifact_title(self, agent: AgentRecord, touched_paths: list[str]) -> str:
        if len(touched_paths) == 1:
            return f"{agent.name} updated {touched_paths[0]}"
        return f"{agent.name} updated {len(touched_paths)} files"

    def _notification_title(self, agent: AgentRecord, job: JobRecord | None, trigger: str) -> str:
        if trigger == "manual":
            return f"{agent.name} reported back"
        if job is not None:
            return f"{agent.name} completed {job.name}"
        return f"{agent.name} completed a run"

    def _run_payload(self, run: RunRecord) -> dict[str, object]:
        return {
            "id": run.id,
            "agentId": run.agent_id,
            "jobId": run.job_id,
            "threadId": run.thread_id,
            "turnId": run.turn_id,
            "trigger": run.trigger,
            "status": run.status,
            "startedAt": run.started_at,
            "finishedAt": run.finished_at,
            "summaryText": run.summary_text,
            "errorText": run.error_text,
            "touchedPaths": run.touched_paths,
        }

    def _activity_payload(self, activity: ActivityRecord) -> dict[str, object]:
        return {
            "id": activity.id,
            "agentId": activity.agent_id,
            "jobId": activity.job_id,
            "runId": activity.run_id,
            "threadId": activity.thread_id,
            "turnId": activity.turn_id,
            "kind": activity.kind,
            "status": activity.status,
            "title": activity.title,
            "body": activity.body,
            "primaryPath": activity.primary_path,
            "paths": activity.paths,
            "metadata": activity.metadata,
            "createdAt": activity.created_at,
            "updatedAt": activity.updated_at,
        }


class JobScheduler:
    def __init__(
        self,
        store: WebStateStore,
        runtime: AgentRuntime,
        vault: VaultManager,
        poll_seconds: int,
    ) -> None:
        self._store = store
        self._runtime = runtime
        self._vault = vault
        self._poll_seconds = poll_seconds
        self._task: asyncio.Task[None] | None = None
        self._watch_state: dict[str, dict[str, object]] = {}

    async def start(self) -> None:
        if self._task is not None:
            return
        self._sync_all_watch_jobs()
        self._task = asyncio.create_task(self._loop())

    async def close(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)
        self._task = None

    def sync_watch_job(self, job: JobRecord, agent: AgentRecord | None) -> None:
        if not job.enabled or job.trigger_type != "file_watch" or agent is None or not agent.enabled:
            self._watch_state.pop(job.id, None)
            return

        watch_path = job.watch_path or agent.scope_path
        try:
            snapshot = self._vault.snapshot_scope(watch_path or agent.scope_path)
        except Exception:
            self._watch_state.pop(job.id, None)
            return

        self._watch_state[job.id] = {
            "snapshot": snapshot,
            "pendingPaths": set(),
            "lastChangeAt": None,
            "cooldownUntil": None,
            "ignoredPaths": {},
        }

    def _sync_all_watch_jobs(self) -> None:
        agents = {agent.id: agent for agent in self._store.list_agents()}
        active_watch_ids: set[str] = set()
        for job in self._store.list_jobs():
            if job.trigger_type != "file_watch":
                continue
            active_watch_ids.add(job.id)
            self.sync_watch_job(job, agents.get(job.agent_id))
        for job_id in list(self._watch_state):
            if job_id not in active_watch_ids:
                self._watch_state.pop(job_id, None)

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self._poll_seconds)
            now = datetime.now(timezone.utc)
            now_text = now.isoformat()
            for job in self._store.list_due_jobs(now_text):
                if self._runtime.is_agent_running(job.agent_id):
                    continue
                try:
                    await self._runtime.launch_job_run(job.id, trigger="schedule")
                except ValueError:
                    continue
            await self._poll_file_watch_jobs(now)

    async def _poll_file_watch_jobs(self, now: datetime) -> None:
        agents = {agent.id: agent for agent in self._store.list_agents()}
        for job in self._store.list_jobs():
            if not job.enabled or job.trigger_type != "file_watch":
                continue
            agent = agents.get(job.agent_id)
            if agent is None or not agent.enabled:
                continue

            watch_path = job.watch_path or agent.scope_path
            try:
                snapshot = self._vault.snapshot_scope(watch_path or agent.scope_path)
            except Exception:
                continue

            state = self._watch_state.setdefault(
                job.id,
                {
                    "snapshot": snapshot,
                    "pendingPaths": set(),
                    "lastChangeAt": None,
                    "cooldownUntil": None,
                    "ignoredPaths": {},
                },
            )

            previous_snapshot = state["snapshot"]
            assert isinstance(previous_snapshot, dict)
            changed_paths = self._vault.diff_snapshots(previous_snapshot, snapshot)
            state["snapshot"] = snapshot

            ignored_paths = state["ignoredPaths"]
            assert isinstance(ignored_paths, dict)
            for path, ignore_until in list(ignored_paths.items()):
                if not isinstance(ignore_until, datetime) or now >= ignore_until:
                    ignored_paths.pop(path, None)
            changed_paths = [path for path in changed_paths if path not in ignored_paths]

            cooldown_until = state["cooldownUntil"]
            if isinstance(cooldown_until, datetime) and now < cooldown_until:
                continue

            if changed_paths:
                pending_paths = state["pendingPaths"]
                assert isinstance(pending_paths, set)
                pending_paths.update(changed_paths)
                state["lastChangeAt"] = now

            last_change_at = state["lastChangeAt"]
            debounce_seconds = job.watch_debounce_seconds or 5
            if not isinstance(last_change_at, datetime):
                continue
            if now - last_change_at < timedelta(seconds=debounce_seconds):
                continue
            if self._runtime.is_agent_running(job.agent_id):
                continue

            pending_paths = state["pendingPaths"]
            assert isinstance(pending_paths, set)
            if not pending_paths:
                continue

            try:
                await self._runtime.launch_job_run(
                    job.id,
                    trigger="file_watch",
                    trigger_context={
                        "changedPaths": sorted(pending_paths),
                        "watchPath": watch_path,
                    },
                )
            except ValueError:
                continue

            state["pendingPaths"] = set()
            state["lastChangeAt"] = None
            state["cooldownUntil"] = now + timedelta(seconds=debounce_seconds)
            ignore_until = now + timedelta(seconds=max(debounce_seconds * 2, 15))
            for path in pending_paths:
                ignored_paths[path] = ignore_until
