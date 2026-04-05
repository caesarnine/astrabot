from __future__ import annotations

import argparse
import asyncio
import logging

from .frontends.telegram_bot import TelegramFrontend
from .frontends.tui import TuiFrontend
from .service import AstraService
from .settings import Settings
from .web import run_web_frontend


def main() -> None:
    parser = argparse.ArgumentParser(description="Astra: Codex over Telegram, a local TUI, or a web app.")
    parser.add_argument("mode", choices=["tui", "telegram", "web"])
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    settings = Settings.load()
    if args.mode == "web":
        run_web_frontend(settings)
        return

    service = AstraService(settings)

    try:
        if args.mode == "tui":
            asyncio.run(TuiFrontend(service, settings.tui_context_id).run())
        else:
            asyncio.run(TelegramFrontend(service, settings).run())
    finally:
        try:
            asyncio.run(service.close())
        except RuntimeError:
            pass
