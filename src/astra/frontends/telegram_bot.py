from __future__ import annotations

import asyncio

from telegram import BotCommand, Update
from telegram.ext import Application, ApplicationBuilder, CommandHandler, ContextTypes, MessageHandler, filters

from ..service import AstraService
from ..settings import Settings


class TelegramFrontend:
    def __init__(self, service: AstraService, settings: Settings) -> None:
        self._service = service
        self._settings = settings

    async def run(self) -> None:
        if not self._settings.telegram_bot_token:
            raise RuntimeError("TELEGRAM_BOT_TOKEN is required for telegram mode")

        await self._service.start()

        app = ApplicationBuilder().token(self._settings.telegram_bot_token).build()
        self._register_handlers(app)

        await app.initialize()
        await app.start()
        await app.bot.set_my_commands(
            [
                BotCommand("help", "Show help"),
                BotCommand("login", "Start ChatGPT login"),
                BotCommand("whoami", "Show Telegram ids for lock-down"),
                BotCommand("status", "Show auth and thread status"),
                BotCommand("new", "Create a new thread"),
                BotCommand("threads", "List recent threads"),
                BotCommand("use", "Switch to a thread"),
                BotCommand("rename", "Rename the active thread"),
                BotCommand("archive", "Archive the active thread"),
            ]
        )

        if app.updater is None:
            raise RuntimeError("Telegram updater is unavailable")

        await app.updater.start_polling()
        print("Telegram bot is running. Press Ctrl+C to stop.")
        try:
            await asyncio.Event().wait()
        finally:
            await app.updater.stop()
            await app.stop()
            await app.shutdown()

    def _register_handlers(self, app: Application) -> None:
        commands = ["start", "help", "login", "logout", "whoami", "status", "new", "clear", "threads", "use", "rename", "archive"]
        for command in commands:
            app.add_handler(CommandHandler(command, self._handle_command))
        app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self._handle_text))

    async def _handle_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not await self._is_allowed(update):
            return

        message = update.effective_message
        if message is None or message.text is None:
            return

        if message.text.startswith("/whoami"):
            await self._reply_text(message, self._whoami_text(update))
            return

        reply = await self._service.handle_input("telegram", self._context_id(update), message.text)
        await self._reply_text(message, reply.text)

    async def _handle_text(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not await self._is_allowed(update):
            return

        message = update.effective_message
        if message is None or message.text is None:
            return

        reply = await self._service.handle_input("telegram", self._context_id(update), message.text)
        await self._reply_text(message, reply.text)

    async def _is_allowed(self, update: Update) -> bool:
        allowed_user_id = self._settings.allowed_telegram_user_id
        if allowed_user_id is None:
            return True

        user = update.effective_user
        message = update.effective_message
        if user is not None and user.id == allowed_user_id:
            return True

        if message is not None:
            await message.reply_text("This bot is restricted to its configured Telegram user.")
        return False

    def _context_id(self, update: Update) -> str:
        message = update.effective_message
        chat = update.effective_chat
        if chat is None:
            return "telegram:unknown"

        message_thread_id = getattr(message, "message_thread_id", None) if message is not None else None
        return f"{chat.id}:{message_thread_id or 0}"

    async def _reply_text(self, message, text: str) -> None:
        chunks = _chunk_text(text, 3900)
        for chunk in chunks:
            await message.reply_text(chunk)

    def _whoami_text(self, update: Update) -> str:
        user = update.effective_user
        chat = update.effective_chat
        message = update.effective_message

        lines = ["Telegram identity:"]
        if user is not None:
            lines.append(f"user_id: {user.id}")
            if user.username:
                lines.append(f"username: @{user.username}")
            full_name = " ".join(part for part in [user.first_name, user.last_name] if part).strip()
            if full_name:
                lines.append(f"name: {full_name}")
        if chat is not None:
            lines.append(f"chat_id: {chat.id}")
            lines.append(f"chat_type: {chat.type}")
        message_thread_id = getattr(message, "message_thread_id", None) if message is not None else None
        if message_thread_id is not None:
            lines.append(f"message_thread_id: {message_thread_id}")

        lines.append("")
        lines.append("Use `[telegram].allowed_user_id` in `astra.toml` or `ASTRA_ALLOWED_TELEGRAM_USER_ID` to restrict the bot.")
        return "\n".join(lines)


def _chunk_text(text: str, limit: int) -> list[str]:
    if len(text) <= limit:
        return [text]

    chunks: list[str] = []
    remaining = text
    while len(remaining) > limit:
        split_at = remaining.rfind("\n", 0, limit)
        if split_at <= 0:
            split_at = limit
        chunks.append(remaining[:split_at].rstrip())
        remaining = remaining[split_at:].lstrip()
    if remaining:
        chunks.append(remaining)
    return chunks
