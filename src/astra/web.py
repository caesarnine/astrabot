from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
import threading
import webbrowser

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import uvicorn

from .agent_runtime import AgentRuntime, JobScheduler
from .events import EventBroker
from .scheduling import cron_preview, next_job_run_at
from .settings import Settings
from .vault import VaultManager
from .web_state import ActivityRecord, AgentRecord, JobRecord, RunRecord, WebStateStore


@dataclass(slots=True)
class WebServices:
    settings: Settings
    store: WebStateStore
    vault: VaultManager
    events: EventBroker
    runtime: AgentRuntime
    scheduler: JobScheduler


class DocumentCreateBody(BaseModel):
    parent: str = ""
    name: str


class DocumentSaveBody(BaseModel):
    content: str


class AgentBody(BaseModel):
    name: str
    prompt: str
    scope_path: str = ""
    output_dir: str = ""
    model: str | None = None
    reasoning_effort: str | None = None
    approval_policy: str | None = None
    sandbox_mode: str | None = None
    enabled: bool = True


class JobBody(BaseModel):
    name: str
    prompt: str
    trigger_type: str = "interval"
    interval_minutes: int | None = Field(default=60, ge=1)
    cron_expression: str | None = None
    watch_path: str | None = None
    watch_debounce_seconds: int | None = Field(default=5, ge=1, le=300)
    enabled: bool = True


class QuickRunBody(BaseModel):
    prompt: str = ""
    context_path: str | None = None


class AskBody(BaseModel):
    prompt: str
    agent_id: str | None = None
    context_path: str | None = None


class AttentionReplyBody(BaseModel):
    text: str


def create_web_app(settings: Settings) -> FastAPI:
    package_dir = Path(__file__).resolve().parent
    frontend_index = package_dir / "static" / "dist" / "index.html"

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store = WebStateStore(settings.db_path)
        store.initialize()
        vault = VaultManager(settings.vault_path, settings.vault_inbox_dir, store)
        vault.initialize()
        events = EventBroker()
        runtime = AgentRuntime(settings, store, vault, events)
        scheduler = JobScheduler(store, runtime, vault, settings.web_scheduler_poll_seconds)
        app.state.services = WebServices(
            settings=settings,
            store=store,
            vault=vault,
            events=events,
            runtime=runtime,
            scheduler=scheduler,
        )
        await runtime.start()
        await scheduler.start()
        yield
        await scheduler.close()
        await runtime.close()
        store.close()

    app = FastAPI(title="Astra", lifespan=lifespan)
    app.mount("/static", StaticFiles(directory=str(package_dir / "static")), name="static")

    @app.get("/", response_class=HTMLResponse)
    async def index(request: Request) -> HTMLResponse:
        if frontend_index.exists():
            return FileResponse(frontend_index)
        return HTMLResponse(_frontend_build_missing_html())

    @app.get("/favicon.ico")
    async def favicon() -> Response:
        return Response(status_code=204)

    @app.get("/api/bootstrap")
    async def bootstrap(request: Request) -> dict[str, object]:
        services = _services(request)
        return {
            "account": await _safe_account_payload(services.runtime),
            "tree": services.vault.list_tree(),
            "agents": [_serialize_agent(agent, services.runtime.is_agent_running(agent.id)) for agent in services.store.list_agents()],
            "activity": _serialize_activity_bundle(services),
            "recentFileActivity": _recent_file_activity_payload(services),
            "appName": "Astra",
            "vaultName": settings.vault_path.name,
            "defaults": {
                "model": settings.codex_model,
                "reasoningEffort": settings.codex_reasoning_effort,
                "approvalPolicy": settings.web_agent_approval_policy,
                "sandboxMode": settings.web_agent_sandbox_mode,
                "inboxDir": settings.vault_inbox_dir,
            },
        }

    @app.get("/api/account")
    async def read_account(request: Request) -> dict[str, object]:
        services = _services(request)
        return await _safe_account_payload(services.runtime)

    @app.post("/api/account/login")
    async def login(request: Request) -> dict[str, object]:
        services = _services(request)
        result = await services.runtime.login_chatgpt()
        auth_url = str(result.get("authUrl", ""))
        if auth_url and settings.web_open_browser:
            webbrowser.open(auth_url)
        return {"authUrl": auth_url}

    @app.post("/api/account/logout")
    async def logout(request: Request) -> dict[str, str]:
        services = _services(request)
        await services.runtime.logout()
        return {"status": "ok"}

    @app.get("/api/tree")
    async def tree(request: Request) -> dict[str, object]:
        return _services(request).vault.list_tree()

    @app.get("/api/documents/{doc_path:path}")
    async def get_document(request: Request, doc_path: str) -> dict[str, object]:
        services = _services(request)
        try:
            document = services.vault.read_document(doc_path)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {
            "path": document.path,
            "kind": document.kind,
            "title": document.title,
            "editable": document.editable,
            "content": document.content,
        }

    @app.put("/api/documents/{doc_path:path}")
    async def save_document(request: Request, doc_path: str, body: DocumentSaveBody) -> dict[str, object]:
        services = _services(request)
        try:
            document = services.vault.save_document(doc_path, body.content)
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        await services.events.publish("vault.changed", {"paths": [document.path]})
        return {
            "path": document.path,
            "kind": document.kind,
            "title": document.title,
            "editable": document.editable,
            "content": document.content,
        }

    @app.post("/api/documents")
    async def create_document(request: Request, body: DocumentCreateBody) -> dict[str, object]:
        services = _services(request)
        try:
            document = services.vault.create_note(body.parent, body.name)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        await services.events.publish("vault.changed", {"paths": [document.path]})
        return {
            "path": document.path,
            "kind": document.kind,
            "title": document.title,
            "editable": document.editable,
            "content": document.content,
        }

    @app.get("/api/search")
    async def search(request: Request, q: str = Query(default="")) -> dict[str, object]:
        services = _services(request)
        query = q.strip()
        if not query:
            return {"results": []}
        return {"results": services.vault.search(query)}

    @app.get("/api/activity")
    async def activity(request: Request) -> dict[str, object]:
        services = _services(request)
        return _serialize_activity_bundle(services)

    @app.get("/api/activity/recent")
    async def recent_activity(request: Request) -> dict[str, object]:
        services = _services(request)
        return {"items": _recent_file_activity_payload(services)}

    @app.post("/api/attention/{activity_id}/reply")
    async def reply_attention(request: Request, activity_id: str, body: AttentionReplyBody) -> dict[str, object]:
        services = _services(request)
        try:
            activity = await services.runtime.reply_to_attention(activity_id, body.text)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Attention request not found.") from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"activity": _serialize_activity(activity)}

    @app.post("/api/attention/{activity_id}/dismiss")
    async def dismiss_attention(request: Request, activity_id: str) -> dict[str, object]:
        services = _services(request)
        try:
            activity = await services.runtime.dismiss_attention(activity_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Attention request not found.") from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"activity": _serialize_activity(activity)}

    @app.get("/api/agents")
    async def list_agents(request: Request) -> dict[str, object]:
        services = _services(request)
        return {
            "agents": [
                _serialize_agent(agent, services.runtime.is_agent_running(agent.id))
                for agent in services.store.list_agents()
            ]
        }

    @app.get("/api/agents/{agent_id}")
    async def get_agent(request: Request, agent_id: str) -> dict[str, object]:
        services = _services(request)
        try:
            agent = services.store.get_agent(agent_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Agent not found.") from exc
        return {
            "agent": _serialize_agent(agent, services.runtime.is_agent_running(agent.id)),
            "jobs": [_serialize_job(job) for job in services.store.list_jobs(agent_id)],
            "runs": [
                _serialize_run(run, services.runtime.is_agent_running(run.agent_id))
                for run in services.store.list_runs(agent_id=agent_id)
            ],
        }

    @app.post("/api/agents")
    async def create_agent(request: Request, body: AgentBody) -> dict[str, object]:
        services = _services(request)
        normalized = _normalize_agent_body(services, body)
        agent = services.store.create_agent(**normalized)
        await services.events.publish("agents.changed", {"agentId": agent.id})
        return {"agent": _serialize_agent(agent, False)}

    @app.patch("/api/agents/{agent_id}")
    async def update_agent(request: Request, agent_id: str, body: AgentBody) -> dict[str, object]:
        services = _services(request)
        try:
            services.store.get_agent(agent_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Agent not found.") from exc
        normalized = _normalize_agent_body(services, body)
        agent = services.store.update_agent(agent_id, **normalized)
        await services.events.publish("agents.changed", {"agentId": agent.id})
        return {"agent": _serialize_agent(agent, services.runtime.is_agent_running(agent.id))}

    @app.post("/api/agents/{agent_id}/runs")
    async def quick_run(request: Request, agent_id: str, body: QuickRunBody) -> dict[str, object]:
        services = _services(request)
        try:
            run = await services.runtime.launch_manual_run(agent_id, body.prompt)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Agent not found.") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"mode": "run", "run": _serialize_run(run, services.runtime.is_agent_running(run.agent_id))}

    @app.post("/api/ask")
    async def ask_agent(request: Request, body: AskBody) -> dict[str, object]:
        services = _services(request)
        if body.agent_id:
            try:
                agent = services.store.get_agent(body.agent_id)
            except KeyError as exc:
                raise HTTPException(status_code=404, detail="Agent not found.") from exc
        else:
            agent = _match_agent_for_path(services.store.list_agents(), body.context_path or "")
            if agent is None:
                raise HTTPException(status_code=400, detail="No agent matches the current document.")

        if services.runtime.is_agent_running(agent.id) and agent.active_turn_id and agent.thread_id:
            await services.runtime.steer_agent(agent.id, body.prompt)
            return {
                "mode": "steer",
                "agentId": agent.id,
            }

        run = await services.runtime.launch_manual_run(agent.id, body.prompt)
        return {
            "mode": "run",
            "agentId": agent.id,
            "run": _serialize_run(run, services.runtime.is_agent_running(run.agent_id)),
        }

    @app.get("/api/agents/{agent_id}/jobs")
    async def list_jobs(request: Request, agent_id: str) -> dict[str, object]:
        services = _services(request)
        return {"jobs": [_serialize_job(job) for job in services.store.list_jobs(agent_id)]}

    @app.post("/api/agents/{agent_id}/jobs")
    async def create_job(request: Request, agent_id: str, body: JobBody) -> dict[str, object]:
        services = _services(request)
        try:
            agent = services.store.get_agent(agent_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Agent not found.") from exc
        normalized = _normalize_job_body(services, agent, body)
        job = services.store.create_job(agent_id=agent_id, **normalized)
        services.scheduler.sync_watch_job(job, agent)
        await services.events.publish("jobs.changed", {"agentId": agent_id, "jobId": job.id})
        return {"job": _serialize_job(job)}

    @app.patch("/api/jobs/{job_id}")
    async def update_job(request: Request, job_id: str, body: JobBody) -> dict[str, object]:
        services = _services(request)
        try:
            existing = services.store.get_job(job_id)
            agent = services.store.get_agent(existing.agent_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Job not found.") from exc
        normalized = _normalize_job_body(services, agent, body)
        job = services.store.update_job(job_id, **normalized)
        services.scheduler.sync_watch_job(job, agent)
        await services.events.publish("jobs.changed", {"agentId": existing.agent_id, "jobId": job.id})
        return {"job": _serialize_job(job)}

    @app.post("/api/jobs/{job_id}/run")
    async def run_job(request: Request, job_id: str) -> dict[str, object]:
        services = _services(request)
        try:
            run = await services.runtime.launch_job_run(job_id, trigger="manual")
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Job not found.") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"run": _serialize_run(run, services.runtime.is_agent_running(run.agent_id))}

    @app.get("/api/runs")
    async def list_runs(request: Request, agent_id: str | None = None) -> dict[str, object]:
        services = _services(request)
        return {
            "runs": [
                _serialize_run(run, services.runtime.is_agent_running(run.agent_id))
                for run in services.store.list_runs(agent_id=agent_id)
            ]
        }

    @app.get("/api/runs/{run_id}")
    async def get_run(request: Request, run_id: str) -> dict[str, object]:
        services = _services(request)
        try:
            run = services.store.get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Run not found.") from exc
        return {"run": _serialize_run(run, services.runtime.is_agent_running(run.agent_id))}

    @app.websocket("/api/events")
    async def events(websocket: WebSocket) -> None:
        await websocket.accept()
        services = websocket.app.state.services
        queue = services.events.subscribe()
        try:
            while True:
                event = await queue.get()
                await websocket.send_json(event)
        except (WebSocketDisconnect, asyncio.CancelledError):
            services.events.unsubscribe(queue)
        finally:
            services.events.unsubscribe(queue)

    return app


def run_web_frontend(settings: Settings) -> None:
    app = create_web_app(settings)
    url = f"http://{settings.web_host}:{settings.web_port}"
    if settings.web_open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=settings.web_host, port=settings.web_port, log_level="info")


def _services(request: Request) -> WebServices:
    return request.app.state.services


async def _safe_account_payload(runtime: AgentRuntime) -> dict[str, object]:
    try:
        account = await asyncio.wait_for(runtime.read_account(), timeout=1.5)
    except (asyncio.TimeoutError, Exception):
        cached = runtime.last_account()
        if cached is not None:
            return _serialize_account(cached)
        return {"loggedIn": False, "email": None, "authType": None}
    return _serialize_account(account)


def _frontend_build_missing_html() -> str:
    return """
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Astra</title>
        <style>
          body {
            margin: 0;
            font-family: system-ui, sans-serif;
            background: #f4f1ec;
            color: #1a1c19;
          }
          main {
            max-width: 42rem;
            margin: 12vh auto 0;
            padding: 2rem;
            background: white;
            border-radius: 16px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.08);
          }
          h1 {
            margin-top: 0;
            font-size: 1.8rem;
          }
          code {
            padding: 0.1rem 0.35rem;
            border-radius: 6px;
            background: #f0eeea;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>Frontend build missing</h1>
          <p>The React app has not been built yet.</p>
          <p>Run <code>cd frontend && npm install && npm run build</code> for production, or <code>cd frontend && npm run dev</code> for local UI development.</p>
        </main>
      </body>
    </html>
    """.strip()


def _normalize_agent_body(services: WebServices, body: AgentBody) -> dict[str, object]:
    try:
        scope_path = services.vault.to_rel_path(services.vault.resolve_dir(body.scope_path))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    output_dir_value = body.output_dir.strip() or scope_path or services.settings.vault_inbox_dir
    try:
        output_dir = services.vault.to_rel_path(services.vault.resolve_dir(output_dir_value))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if scope_path and output_dir and output_dir != scope_path and not output_dir.startswith(f"{scope_path}/"):
        raise HTTPException(status_code=400, detail="Output directory must be inside the agent scope.")

    return {
        "name": body.name.strip(),
        "prompt": body.prompt.strip(),
        "scope_path": scope_path,
        "output_dir": output_dir or scope_path or services.settings.vault_inbox_dir,
        "model": body.model or services.settings.codex_model,
        "reasoning_effort": body.reasoning_effort or services.settings.codex_reasoning_effort,
        "approval_policy": body.approval_policy or services.settings.web_agent_approval_policy,
        "sandbox_mode": body.sandbox_mode or services.settings.web_agent_sandbox_mode,
        "enabled": body.enabled,
    }


def _normalize_job_body(services: WebServices, agent: AgentRecord, body: JobBody) -> dict[str, object]:
    trigger_type = body.trigger_type.strip().lower().replace("-", "_")
    if trigger_type not in {"manual", "interval", "cron", "file_watch"}:
        raise HTTPException(status_code=400, detail="Trigger type must be manual, interval, cron, or file_watch.")

    interval_minutes = body.interval_minutes if trigger_type == "interval" else None
    cron_expression = (body.cron_expression or "").strip() or None
    watch_path_value = (body.watch_path or "").strip() or None
    watch_debounce_seconds = body.watch_debounce_seconds if trigger_type == "file_watch" else None

    if trigger_type == "cron" and not cron_expression:
        raise HTTPException(status_code=400, detail="Cron jobs require a cron expression.")
    if trigger_type == "interval" and not interval_minutes:
        raise HTTPException(status_code=400, detail="Interval jobs require an interval.")

    watch_path = None
    if trigger_type == "file_watch":
        candidate = watch_path_value or agent.scope_path
        try:
            watch_path = services.vault.to_rel_path(services.vault.resolve_dir(candidate))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if agent.scope_path and watch_path and watch_path != agent.scope_path and not watch_path.startswith(f"{agent.scope_path}/"):
            raise HTTPException(status_code=400, detail="Watch path must be inside the agent scope.")

    preview_job = JobRecord(
        id="preview",
        agent_id=agent.id,
        name=body.name.strip(),
        prompt=body.prompt.strip(),
        trigger_type=trigger_type,
        interval_minutes=interval_minutes,
        cron_expression=cron_expression,
        watch_path=watch_path,
        watch_debounce_seconds=watch_debounce_seconds,
        next_run_at=None,
        last_run_at=None,
        enabled=body.enabled,
        created_at="",
        updated_at="",
    )
    return {
        "name": body.name.strip(),
        "prompt": body.prompt.strip(),
        "trigger_type": trigger_type,
        "interval_minutes": interval_minutes,
        "cron_expression": cron_expression,
        "watch_path": watch_path,
        "watch_debounce_seconds": watch_debounce_seconds,
        "next_run_at": next_job_run_at(preview_job),
        "enabled": body.enabled,
    }


def _serialize_account(result: dict[str, object]) -> dict[str, object]:
    account = result.get("account")
    if not isinstance(account, dict):
        return {"loggedIn": False, "email": None, "authType": None}
    return {
        "loggedIn": True,
        "email": account.get("email"),
        "authType": account.get("type"),
    }


def _serialize_agent(agent: AgentRecord, is_running: bool) -> dict[str, object]:
    last_run_status = agent.last_run_status
    if last_run_status in {"queued", "running"} and not is_running:
        last_run_status = "failed"

    return {
        "id": agent.id,
        "name": agent.name,
        "prompt": agent.prompt,
        "scopePath": agent.scope_path,
        "outputDir": agent.output_dir,
        "threadId": agent.thread_id,
        "model": agent.model,
        "reasoningEffort": agent.reasoning_effort,
        "approvalPolicy": agent.approval_policy,
        "sandboxMode": agent.sandbox_mode,
        "enabled": agent.enabled,
        "createdAt": agent.created_at,
        "updatedAt": agent.updated_at,
        "lastRunAt": agent.last_run_at,
        "lastRunStatus": last_run_status,
        "nextRunAt": agent.next_run_at,
        "activeTurnId": agent.active_turn_id,
        "isRunning": is_running,
    }


def _serialize_job(job: JobRecord) -> dict[str, object]:
    return {
        "id": job.id,
        "agentId": job.agent_id,
        "name": job.name,
        "prompt": job.prompt,
        "triggerType": job.trigger_type,
        "intervalMinutes": job.interval_minutes,
        "cronExpression": job.cron_expression,
        "cronPreview": cron_preview(job.cron_expression),
        "watchPath": job.watch_path,
        "watchDebounceSeconds": job.watch_debounce_seconds,
        "nextRunAt": job.next_run_at,
        "lastRunAt": job.last_run_at,
        "enabled": job.enabled,
        "createdAt": job.created_at,
        "updatedAt": job.updated_at,
    }


def _serialize_run(run: RunRecord, is_running: bool) -> dict[str, object]:
    status = run.status
    error_text = run.error_text
    if status in {"queued", "running"} and not is_running:
        status = "failed"
        error_text = error_text or "Astra was restarted before this run completed."

    return {
        "id": run.id,
        "agentId": run.agent_id,
        "jobId": run.job_id,
        "threadId": run.thread_id,
        "turnId": run.turn_id,
        "trigger": run.trigger,
        "status": status,
        "startedAt": run.started_at,
        "finishedAt": run.finished_at,
        "summaryText": run.summary_text,
        "errorText": error_text,
        "touchedPaths": run.touched_paths,
    }


def _serialize_activity(activity: ActivityRecord) -> dict[str, object]:
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


def _serialize_activity_bundle(services: WebServices) -> dict[str, object]:
    now = datetime.now(timezone.utc)
    since = (now - timedelta(hours=24)).isoformat()
    activities = services.store.list_activity(limit=80, since_text=since, include_attention=True)
    attention = [
        _serialize_activity(activity)
        for activity in activities
        if activity.kind == "attention" and activity.status == "pending"
    ]
    today = [
        _serialize_activity(activity)
        for activity in activities
        if not (activity.kind == "attention" and activity.status == "pending")
    ]
    upcoming = []
    for agent in services.store.list_agents():
        for job in services.store.list_jobs(agent.id):
            if not job.enabled:
                continue
            if job.trigger_type == "manual":
                continue
            upcoming.append(
                {
                    "id": job.id,
                    "agentId": agent.id,
                    "agentName": agent.name,
                    "jobName": job.name,
                    "triggerType": job.trigger_type,
                    "nextRunAt": job.next_run_at,
                    "watchPath": job.watch_path or agent.scope_path,
                }
            )
    upcoming.sort(key=lambda item: item["nextRunAt"] or "9999")
    return {
        "attention": attention,
        "today": today,
        "upcoming": upcoming,
    }


def _recent_file_activity_payload(services: WebServices) -> dict[str, object]:
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    recent = services.store.recent_file_activity(since_text=since)
    agents = {agent.id: agent for agent in services.store.list_agents()}
    payload: dict[str, object] = {}
    for path, item in recent.items():
        agent = agents.get(str(item["agentId"]))
        payload[path] = {
            **item,
            "agentName": agent.name if agent else None,
        }
    return payload


def _match_agent_for_path(agents: list[AgentRecord], path: str) -> AgentRecord | None:
    normalized = path.strip().strip("/")
    candidates: list[tuple[int, AgentRecord]] = []
    for agent in agents:
        if not agent.enabled:
            continue
        scope = agent.scope_path.strip().strip("/")
        if not scope:
            candidates.append((0, agent))
            continue
        if normalized == scope or normalized.startswith(f"{scope}/"):
            candidates.append((len(scope), agent))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]
