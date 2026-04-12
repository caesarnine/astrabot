from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import logging
from typing import Any, Awaitable, Callable

from .settings import Settings

logger = logging.getLogger(__name__)

_APP_SERVER_STREAM_LIMIT = 16 * 1024 * 1024

TurnEventHandler = Callable[[dict[str, Any]], Awaitable[dict[str, Any] | None]]
DynamicToolSpec = dict[str, Any]


class CodexAppServerError(RuntimeError):
    pass


@dataclass(slots=True)
class ThreadSummary:
    thread_id: str
    name: str | None
    preview: str
    updated_at: int | None


@dataclass(slots=True)
class TurnExecutionResult:
    thread_id: str
    turn_id: str
    text: str
    turn: dict[str, Any]


class CodexAppServerClient:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._process: asyncio.subprocess.Process | None = None
        self._request_id = 0
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._turn_waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._turn_backlog: dict[str, dict[str, Any]] = {}
        self._turn_handlers: dict[str, TurnEventHandler] = {}
        self._loaded_threads: set[str] = set()
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._send_lock = asyncio.Lock()

    async def start(self) -> None:
        if self._process is not None:
            return

        self._process = await asyncio.create_subprocess_exec(
            self._settings.codex_bin,
            "app-server",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=_APP_SERVER_STREAM_LIMIT,
        )
        self._reader_task = asyncio.create_task(self._reader_loop())
        self._stderr_task = asyncio.create_task(self._stderr_loop())

        await self.request(
            "initialize",
            {
                "clientInfo": {
                    "name": "astra",
                    "title": "Astra",
                    "version": "0.1.0",
                },
                "capabilities": {
                    "experimentalApi": True,
                },
            },
        )
        await self.notify("initialized", {})

    async def close(self) -> None:
        if self._process is None:
            return

        if self._process.stdin:
            self._process.stdin.close()

        if self._reader_task is not None:
            self._reader_task.cancel()
        if self._stderr_task is not None:
            self._stderr_task.cancel()

        try:
            await asyncio.wait_for(self._process.wait(), timeout=2)
        except asyncio.TimeoutError:
            self._process.terminate()
            await self._process.wait()

        self._process = None

    async def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if self._process is None:
            raise CodexAppServerError("codex app-server is not running")
        self._raise_if_reader_stopped()

        self._request_id += 1
        request_id = self._request_id
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[request_id] = future
        payload: dict[str, Any] = {"method": method, "id": request_id}
        if params is not None:
            payload["params"] = params
        await self._send(payload)
        response = await future
        if "error" in response:
            error = response["error"]
            raise CodexAppServerError(error.get("message", str(error)))
        return response.get("result", {})

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self._raise_if_reader_stopped()
        payload: dict[str, Any] = {"method": method}
        if params is not None:
            payload["params"] = params
        await self._send(payload)

    async def read_account(self) -> dict[str, Any]:
        return await self.request("account/read", {"refreshToken": False})

    async def login_chatgpt(self) -> dict[str, Any]:
        return await self.request("account/login/start", {"type": "chatgpt"})

    async def logout(self) -> None:
        await self.request("account/logout")

    async def start_thread(
        self,
        *,
        cwd: str | None = None,
        model: str | None = None,
        personality: str | None = None,
        approval_policy: str | None = None,
        sandbox_mode: str | None = None,
        base_instructions: str | None = None,
        developer_instructions: str | None = None,
        dynamic_tools: list[DynamicToolSpec] | None = None,
    ) -> dict[str, Any]:
        params = self._thread_params(
            cwd=cwd,
            model=model,
            personality=personality,
            approval_policy=approval_policy,
            sandbox_mode=sandbox_mode,
            base_instructions=base_instructions,
            developer_instructions=developer_instructions,
            dynamic_tools=dynamic_tools,
        )
        result = await self.request(
            "thread/start",
            params,
        )
        thread_id = result.get("thread", {}).get("id")
        if thread_id:
            self._loaded_threads.add(thread_id)
        return result

    async def resume_thread(
        self,
        thread_id: str,
        *,
        cwd: str | None = None,
        model: str | None = None,
        personality: str | None = None,
        approval_policy: str | None = None,
        sandbox_mode: str | None = None,
        base_instructions: str | None = None,
        developer_instructions: str | None = None,
        dynamic_tools: list[DynamicToolSpec] | None = None,
    ) -> dict[str, Any]:
        params = self._thread_params(
            cwd=cwd,
            model=model,
            personality=personality,
            approval_policy=approval_policy,
            sandbox_mode=sandbox_mode,
            base_instructions=base_instructions,
            developer_instructions=developer_instructions,
            dynamic_tools=dynamic_tools,
        )
        params["threadId"] = thread_id
        result = await self.request(
            "thread/resume",
            params,
        )
        self._loaded_threads.add(thread_id)
        return result

    async def set_thread_name(self, thread_id: str, name: str) -> None:
        await self.request("thread/name/set", {"threadId": thread_id, "name": name})

    async def archive_thread(self, thread_id: str) -> None:
        await self.request("thread/archive", {"threadId": thread_id})

    async def read_thread(self, thread_id: str, include_turns: bool) -> dict[str, Any]:
        return await self.request(
            "thread/read",
            {"threadId": thread_id, "includeTurns": include_turns},
        )

    async def list_threads(self, limit: int = 15) -> list[ThreadSummary]:
        result = await self.request(
            "thread/list",
            {
                "limit": limit,
                "sortKey": "updated_at",
            },
        )
        return [
            ThreadSummary(
                thread_id=item["id"],
                name=item.get("name"),
                preview=item.get("preview", ""),
                updated_at=item.get("updatedAt"),
            )
            for item in result.get("data", [])
        ]

    async def run_turn(
        self,
        thread_id: str,
        text: str,
        effort: str | None = None,
        *,
        cwd: str | None = None,
        model: str | None = None,
        approval_policy: str | None = None,
        sandbox_mode: str | None = None,
    ) -> str:
        result = await self.run_turn_streamed(
            thread_id,
            text,
            effort=effort,
            cwd=cwd,
            model=model,
            approval_policy=approval_policy,
            sandbox_mode=sandbox_mode,
        )
        return result.text

    async def run_turn_streamed(
        self,
        thread_id: str,
        text: str,
        effort: str | None = None,
        *,
        cwd: str | None = None,
        model: str | None = None,
        approval_policy: str | None = None,
        sandbox_mode: str | None = None,
        on_event: TurnEventHandler | None = None,
    ) -> TurnExecutionResult:
        params: dict[str, Any] = {
            "threadId": thread_id,
            "input": [{"type": "text", "text": text}],
            "approvalPolicy": approval_policy or self._settings.codex_approval_policy,
            "sandboxPolicy": _sandbox_policy_for_mode(sandbox_mode or self._settings.codex_sandbox_mode),
        }
        if effort is not None:
            params["effort"] = effort
        if cwd is not None:
            params["cwd"] = cwd
        if model is not None:
            params["model"] = model

        result = await self.request(
            "turn/start",
            params,
        )
        turn = result.get("turn", {})
        turn_id = turn.get("id")
        if not turn_id:
            raise CodexAppServerError("turn/start did not return a turn id")

        if on_event is not None:
            self._turn_handlers[turn_id] = on_event
            await on_event(
                {
                    "kind": "turn_started",
                    "turnId": turn_id,
                    "threadId": thread_id,
                }
            )

        try:
            completed_turn = await self._wait_for_turn_completion(turn_id)
        finally:
            self._turn_handlers.pop(turn_id, None)

        extracted = self._extract_agent_text(completed_turn)
        if not extracted:
            thread_result = await self.read_thread(thread_id, include_turns=True)
            stored_thread = thread_result.get("thread", {})
            for stored_turn in reversed(stored_thread.get("turns", [])):
                if stored_turn.get("id") == turn_id:
                    extracted = self._extract_agent_text(stored_turn)
                    if extracted:
                        completed_turn = stored_turn
                    break

        if not extracted and completed_turn.get("error"):
            extracted = completed_turn["error"].get("message", "Turn failed.")
        if not extracted:
            extracted = "No response text was returned."

        return TurnExecutionResult(
            thread_id=thread_id,
            turn_id=turn_id,
            text=extracted,
            turn=completed_turn,
        )

    async def steer_turn(
        self,
        thread_id: str,
        turn_id: str,
        text: str,
    ) -> None:
        await self.request(
            "turn/steer",
            {
                "threadId": thread_id,
                "expectedTurnId": turn_id,
                "input": [{"type": "text", "text": text}],
            },
        )

    async def interrupt_turn(self, thread_id: str, turn_id: str) -> None:
        await self.request(
            "turn/interrupt",
            {
                "threadId": thread_id,
                "turnId": turn_id,
            },
        )

    def is_thread_loaded(self, thread_id: str) -> bool:
        return thread_id in self._loaded_threads

    async def _wait_for_turn_completion(self, turn_id: str) -> dict[str, Any]:
        if turn_id in self._turn_backlog:
            return self._turn_backlog.pop(turn_id)

        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._turn_waiters[turn_id] = future
        try:
            return await future
        finally:
            self._turn_waiters.pop(turn_id, None)

    def _thread_params(
        self,
        *,
        cwd: str | None,
        model: str | None,
        personality: str | None,
        approval_policy: str | None,
        sandbox_mode: str | None,
        base_instructions: str | None,
        developer_instructions: str | None,
        dynamic_tools: list[DynamicToolSpec] | None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "model": model or self._settings.codex_model,
            "personality": personality or self._settings.codex_personality,
            "approvalPolicy": approval_policy or self._settings.codex_approval_policy,
            "sandbox": sandbox_mode or self._settings.codex_sandbox_mode,
        }
        effective_base = base_instructions or self._settings.codex_base_instructions
        effective_developer = developer_instructions or self._settings.codex_developer_instructions
        if effective_base is not None:
            params["baseInstructions"] = effective_base
        if effective_developer is not None:
            params["developerInstructions"] = effective_developer
        if cwd is not None:
            params["cwd"] = cwd
        if dynamic_tools:
            params["dynamicTools"] = dynamic_tools
        return params

    def _extract_agent_text(self, turn: dict[str, Any]) -> str:
        items = turn.get("items", [])
        final_answer = ""
        commentary = ""
        for item in items:
            if item.get("type") != "agentMessage":
                continue
            text = (item.get("text") or "").strip()
            if not text:
                continue
            if item.get("phase") == "final_answer":
                final_answer = text
            else:
                commentary = text

        if final_answer:
            return final_answer
        if commentary:
            return commentary
        if turn.get("status") == "failed":
            error = turn.get("error") or {}
            return error.get("message", "Turn failed.")
        return ""

    async def _send(self, payload: dict[str, Any]) -> None:
        if self._process is None or self._process.stdin is None:
            raise CodexAppServerError("codex app-server stdin is unavailable")

        data = json.dumps(payload, separators=(",", ":")) + "\n"
        async with self._send_lock:
            self._process.stdin.write(data.encode("utf-8"))
            await self._process.stdin.drain()

    async def _reader_loop(self) -> None:
        assert self._process is not None
        assert self._process.stdout is not None

        failure_message = "codex app-server stopped"
        try:
            while True:
                line = await self._process.stdout.readline()
                if not line:
                    break

                message = json.loads(line.decode("utf-8"))
                if "id" in message and ("result" in message or "error" in message):
                    future = self._pending.pop(message["id"], None)
                    if future and not future.done():
                        future.set_result(message)
                    continue

                if "id" in message and "method" in message:
                    await self._handle_server_request(message)
                    continue

                if "method" in message:
                    self._handle_notification(message)
        except asyncio.CancelledError:
            failure_message = "codex app-server reader was cancelled"
            raise
        except Exception as exc:
            failure_message = f"codex app-server reader crashed: {exc}"
            logger.exception("codex app-server reader crashed")
        finally:
            self._fail_outstanding(failure_message)

    async def _stderr_loop(self) -> None:
        assert self._process is not None
        assert self._process.stderr is not None

        while True:
            line = await self._process.stderr.readline()
            if not line:
                break
            logger.debug("codex app-server stderr: %s", line.decode("utf-8").rstrip())

    async def _handle_server_request(self, message: dict[str, Any]) -> None:
        method = message["method"]
        request_id = message["id"]
        params = message.get("params", {})
        turn_id = params.get("turnId")

        if turn_id:
            handler = self._turn_handlers.get(turn_id)
            if handler is not None:
                response = await handler(
                    {
                        "kind": "server_request",
                        "requestId": request_id,
                        "method": method,
                        "params": params,
                        "turnId": turn_id,
                        "threadId": params.get("threadId"),
                    }
                )
                if response is not None:
                    await self._send({"id": request_id, "result": response})
                    return

        if method == "item/commandExecution/requestApproval":
            decision = "accept" if self._settings.codex_approval_policy == "never" else "decline"
            await self._send({"id": request_id, "result": {"decision": decision}})
            return

        if method == "item/fileChange/requestApproval":
            decision = "accept" if self._settings.codex_approval_policy == "never" else "decline"
            await self._send({"id": request_id, "result": {"decision": decision}})
            return

        await self._send(
            {
                "id": request_id,
                "error": {"code": -32601, "message": f"Unsupported server request: {method}"},
            }
        )

    def _handle_notification(self, message: dict[str, Any]) -> None:
        method = message["method"]
        params = message.get("params", {})

        if method == "thread/started":
            thread = params.get("thread", {})
            thread_id = thread.get("id")
            if thread_id:
                self._loaded_threads.add(thread_id)
            return

        if method == "thread/closed":
            thread_id = params.get("threadId")
            if thread_id:
                self._loaded_threads.discard(thread_id)
            return

        if method == "turn/completed":
            turn = params.get("turn", {})
            turn_id = turn.get("id")
            if not turn_id:
                return

            waiter = self._turn_waiters.get(turn_id)
            if waiter is not None and not waiter.done():
                waiter.set_result(turn)
            else:
                self._turn_backlog[turn_id] = turn

        turn_id = params.get("turnId")
        if turn_id:
            handler = self._turn_handlers.get(turn_id)
            if handler is not None:
                asyncio.create_task(
                    handler(
                        {
                            "kind": "notification",
                            "method": method,
                            "params": params,
                            "turnId": turn_id,
                            "threadId": params.get("threadId"),
                        }
                    )
                )

    def _raise_if_reader_stopped(self) -> None:
        task = self._reader_task
        if task is None or not task.done():
            return

        try:
            exc = task.exception()
        except asyncio.CancelledError as err:
            raise CodexAppServerError("codex app-server reader was cancelled") from err

        if exc is None:
            raise CodexAppServerError("codex app-server reader stopped")
        raise CodexAppServerError(f"codex app-server reader crashed: {exc}") from exc

    def _fail_outstanding(self, message: str) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(CodexAppServerError(message))
        self._pending.clear()

        for future in self._turn_waiters.values():
            if not future.done():
                future.set_exception(CodexAppServerError(message))
        self._turn_waiters.clear()
        self._turn_backlog.clear()


def _sandbox_policy_for_mode(mode: str) -> dict[str, Any]:
    if mode == "danger-full-access":
        return {"type": "dangerFullAccess"}
    if mode == "workspace-write":
        return {"type": "workspaceWrite", "networkAccess": False}
    return {"type": "readOnly", "networkAccess": False}
