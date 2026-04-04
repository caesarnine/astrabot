from __future__ import annotations

import asyncio
from dataclasses import dataclass
import shlex
import textwrap
import webbrowser

from .app_server import CodexAppServerClient, CodexAppServerError
from .settings import REASONING_EFFORTS, Settings
from .state import StateStore


@dataclass(slots=True)
class ServiceReply:
    text: str


class AstraService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._state = StateStore(settings.db_path)
        self._client = CodexAppServerClient(settings)
        self._started = False
        self._start_lock = asyncio.Lock()
        self._locks: dict[str, asyncio.Lock] = {}

    async def start(self) -> None:
        async with self._start_lock:
            if self._started:
                return
            self._state.initialize()
            await self._client.start()
            self._started = True

    async def close(self) -> None:
        self._state.close()
        await self._client.close()

    async def handle_input(self, frontend_kind: str, context_id: str, text: str) -> ServiceReply:
        await self.start()

        stripped = text.strip()
        if not stripped:
            return ServiceReply("Please enter a message or command.")

        try:
            if stripped.startswith("/"):
                return await self._handle_command(frontend_kind, context_id, stripped)
            return await self._handle_chat_message(frontend_kind, context_id, stripped)
        except CodexAppServerError as exc:
            return ServiceReply(f"Codex error: {exc}")

    async def _handle_command(self, frontend_kind: str, context_id: str, text: str) -> ServiceReply:
        try:
            parts = shlex.split(text)
        except ValueError as exc:
            return ServiceReply(f"Invalid command: {exc}")

        command = parts[0].lower()
        args = parts[1:]

        if command in {"/help", "/start"}:
            return ServiceReply(self._help_text())

        if command == "/login":
            result = await self._client.login_chatgpt()
            auth_url = result.get("authUrl", "")
            if frontend_kind == "tui" and auth_url and self._settings.open_browser_on_login:
                webbrowser.open(auth_url)
            return ServiceReply(
                "\n".join(
                    [
                        "Open this URL to log in with ChatGPT:",
                        auth_url or "(no auth URL returned)",
                        "",
                        "Important: open it from the same machine running Astra whenever possible,",
                        "because Codex app-server uses a localhost callback.",
                    ]
                )
            )

        if command == "/logout":
            await self._client.logout()
            return ServiceReply("Logged out of Codex app-server.")

        if command == "/status":
            return await self._status(frontend_kind, context_id)

        if command in {"/new", "/clear"}:
            title = " ".join(args).strip() or None
            return await self._new_thread(frontend_kind, context_id, title)

        if command == "/effort":
            if not args:
                return await self._show_effort(frontend_kind, context_id)
            return await self._set_effort(frontend_kind, context_id, args[0])

        if command == "/threads":
            return await self._list_threads(frontend_kind, context_id)

        if command == "/use":
            if not args:
                return ServiceReply("Usage: /use <thread-id-prefix-or-title>")
            selector = " ".join(args)
            return await self._use_thread(frontend_kind, context_id, selector)

        if command == "/rename":
            if not args:
                return ServiceReply("Usage: /rename <title>")
            title = " ".join(args).strip()
            return await self._rename_thread(frontend_kind, context_id, title)

        if command == "/archive":
            return await self._archive_thread(frontend_kind, context_id)

        if command in {"/exit", "/quit"}:
            return ServiceReply("Goodbye.")

        return ServiceReply(f"Unknown command: {command}\n\n{self._help_text()}")

    async def _handle_chat_message(
        self,
        frontend_kind: str,
        context_id: str,
        text: str,
    ) -> ServiceReply:
        existing_thread_id = self._state.get_active_thread_id(frontend_kind, context_id)
        lock = self._lock_for(existing_thread_id or f"context:{frontend_kind}:{context_id}")

        async with lock:
            thread_id = self._state.get_active_thread_id(frontend_kind, context_id)
            if thread_id:
                if not self._client.is_thread_loaded(thread_id):
                    await self._client.resume_thread(thread_id)
            else:
                thread = await self._client.start_thread()
                thread_id = thread["thread"]["id"]
                self._state.set_active_thread_id(frontend_kind, context_id, thread_id)
                self._state.remember_thread(
                    thread_id,
                    reasoning_effort=self._settings.codex_reasoning_effort,
                )

            effort = self._thread_effort(thread_id)
            reply = await self._client.run_turn(thread_id, text, effort=effort)
            self._state.remember_thread(thread_id, reasoning_effort=effort)
            return ServiceReply(reply)

    async def _status(self, frontend_kind: str, context_id: str) -> ServiceReply:
        account_result = await self._client.read_account()
        account = account_result.get("account")
        active_thread_id = self._state.get_active_thread_id(frontend_kind, context_id)

        if account is None:
            auth_line = "Auth: not logged in"
        else:
            auth_type = account.get("type", "unknown")
            email = account.get("email")
            auth_line = f"Auth: {auth_type}" if not email else f"Auth: {auth_type} ({email})"

        if active_thread_id is None:
            thread_line = "Active thread: none"
            effort_line = f"Reasoning effort: default ({self._settings.codex_reasoning_effort})"
        else:
            thread_result = await self._client.read_thread(active_thread_id, include_turns=False)
            thread = thread_result.get("thread", {})
            name = thread.get("name")
            thread_line = f"Active thread: {active_thread_id}"
            if name:
                thread_line += f" ({name})"
            effort_line = f"Reasoning effort: {self._thread_effort(active_thread_id)}"

        policy_line = f"Approval policy: {self._settings.codex_approval_policy}"
        sandbox_line = f"Sandbox mode: {self._settings.codex_sandbox_mode}"
        return ServiceReply(f"{auth_line}\n{thread_line}\n{effort_line}\n{policy_line}\n{sandbox_line}")

    async def _new_thread(
        self,
        frontend_kind: str,
        context_id: str,
        title: str | None,
    ) -> ServiceReply:
        result = await self._client.start_thread()
        thread_id = result["thread"]["id"]
        if title:
            await self._client.set_thread_name(thread_id, title)
        self._state.set_active_thread_id(frontend_kind, context_id, thread_id)
        self._state.remember_thread(
            thread_id,
            title=title,
            reasoning_effort=self._settings.codex_reasoning_effort,
        )

        if title:
            return ServiceReply(
                f"Switched to new thread {thread_id} ({title}).\nReasoning effort: {self._settings.codex_reasoning_effort}"
            )
        return ServiceReply(
            f"Switched to new thread {thread_id}.\nReasoning effort: {self._settings.codex_reasoning_effort}"
        )

    async def _show_effort(self, frontend_kind: str, context_id: str) -> ServiceReply:
        thread_id = self._state.get_active_thread_id(frontend_kind, context_id)
        if thread_id is None:
            return ServiceReply(
                "There is no active thread.\n"
                f"New threads default to reasoning effort: {self._settings.codex_reasoning_effort}"
            )
        return ServiceReply(
            f"Reasoning effort for {thread_id}: {self._thread_effort(thread_id)}\n"
            f"Available values: {', '.join(REASONING_EFFORTS)}"
        )

    async def _set_effort(self, frontend_kind: str, context_id: str, effort: str) -> ServiceReply:
        normalized = effort.strip().lower()
        if normalized not in REASONING_EFFORTS:
            return ServiceReply(
                f"Invalid effort: {effort}\n"
                f"Available values: {', '.join(REASONING_EFFORTS)}"
            )

        thread_id = self._state.get_active_thread_id(frontend_kind, context_id)
        if thread_id is None:
            return ServiceReply(
                "There is no active thread to update.\n"
                f"New threads default to reasoning effort: {self._settings.codex_reasoning_effort}"
            )

        self._state.set_thread_reasoning_effort(thread_id, normalized)
        return ServiceReply(f"Reasoning effort for {thread_id} is now {normalized}.")

    async def _list_threads(self, frontend_kind: str, context_id: str) -> ServiceReply:
        active_thread_id = self._state.get_active_thread_id(frontend_kind, context_id)
        threads = self._state.list_known_threads()
        if not threads:
            return ServiceReply("No Astra threads found yet.")

        lines = ["Recent threads:"]
        for thread in threads:
            marker = "*" if thread.thread_id == active_thread_id else " "
            name = thread.title or "(untitled)"
            effort = thread.reasoning_effort or self._settings.codex_reasoning_effort
            lines.append(f"{marker} {thread.thread_id}  {name}  [{effort}]")

        lines.append("")
        lines.append("Use /use <thread-id-prefix-or-title> to switch.")
        return ServiceReply("\n".join(lines))

    async def _use_thread(self, frontend_kind: str, context_id: str, selector: str) -> ServiceReply:
        matches = self._state.find_known_threads(selector)
        if not matches:
            return ServiceReply(f"No thread matched: {selector}")
        if len(matches) > 1:
            options = "\n".join(f"- {thread.thread_id}  {thread.title or '(untitled)'}" for thread in matches[:10])
            return ServiceReply(f"Multiple threads matched:\n{options}")

        match = matches[0]
        self._state.set_active_thread_id(frontend_kind, context_id, match.thread_id)
        if not self._client.is_thread_loaded(match.thread_id):
            await self._client.resume_thread(match.thread_id)
        self._state.remember_thread(
            match.thread_id,
            match.title,
            reasoning_effort=match.reasoning_effort or self._settings.codex_reasoning_effort,
        )
        name = match.title or "(untitled)"
        return ServiceReply(
            f"Switched to {match.thread_id} ({name}).\nReasoning effort: {self._thread_effort(match.thread_id)}"
        )

    async def _rename_thread(self, frontend_kind: str, context_id: str, title: str) -> ServiceReply:
        thread_id = self._state.get_active_thread_id(frontend_kind, context_id)
        if thread_id is None:
            return ServiceReply("There is no active thread to rename.")

        await self._client.set_thread_name(thread_id, title)
        self._state.rename_thread(thread_id, title)
        return ServiceReply(f"Renamed {thread_id} to {title}.")

    async def _archive_thread(self, frontend_kind: str, context_id: str) -> ServiceReply:
        thread_id = self._state.get_active_thread_id(frontend_kind, context_id)
        if thread_id is None:
            return ServiceReply("There is no active thread to archive.")

        await self._client.archive_thread(thread_id)
        self._state.set_active_thread_id(frontend_kind, context_id, None)
        return ServiceReply(f"Archived {thread_id}.")

    def _lock_for(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    def _help_text(self) -> str:
        return textwrap.dedent(
            """
            Commands:
            /help
            /login
            /logout
            /status
            /new [title]
            /clear
            /effort [value]
            /threads
            /use <thread-id-prefix-or-title>
            /rename <title>
            /archive

            In Telegram:
            /whoami

            Plain text sends a message to the active Codex thread.
            """
        ).strip()

    def _thread_effort(self, thread_id: str) -> str:
        known_thread = self._state.get_known_thread(thread_id)
        if known_thread is None or known_thread.reasoning_effort is None:
            return self._settings.codex_reasoning_effort
        return known_thread.reasoning_effort
