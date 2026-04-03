from __future__ import annotations

import asyncio

from ..service import AstraService


class TuiFrontend:
    def __init__(self, service: AstraService, context_id: str) -> None:
        self._service = service
        self._context_id = context_id

    async def run(self) -> None:
        await self._service.start()

        print("Astra local chat")
        print("Type /help for commands. Type /exit to quit.")
        print()

        while True:
            try:
                line = await asyncio.to_thread(input, "astra> ")
            except EOFError:
                print()
                break

            reply = await self._service.handle_input("tui", self._context_id, line)
            print()
            print(reply.text)
            print()

            if line.strip().lower() in {"/exit", "/quit"}:
                break

