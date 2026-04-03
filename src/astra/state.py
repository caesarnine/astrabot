from __future__ import annotations

from dataclasses import dataclass
import sqlite3
from pathlib import Path


@dataclass(slots=True)
class KnownThread:
    thread_id: str
    title: str | None
    reasoning_effort: str | None


class StateStore:
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path)
        self._conn.row_factory = sqlite3.Row

    def initialize(self) -> None:
        self._conn.executescript(
            """
            create table if not exists frontend_contexts (
                frontend_kind text not null,
                context_id text not null,
                active_thread_id text null,
                updated_at text not null default current_timestamp,
                primary key (frontend_kind, context_id)
            );

            create table if not exists known_threads (
                thread_id text not null primary key,
                title text null,
                reasoning_effort text null,
                created_at text not null default current_timestamp,
                last_used_at text not null default current_timestamp
            );
            """
        )
        self._ensure_column("known_threads", "reasoning_effort", "text null")
        self._conn.commit()

    def get_active_thread_id(self, frontend_kind: str, context_id: str) -> str | None:
        row = self._conn.execute(
            """
            select active_thread_id
            from frontend_contexts
            where frontend_kind = ? and context_id = ?
            """,
            (frontend_kind, context_id),
        ).fetchone()
        if row is None:
            return None
        return row["active_thread_id"]

    def set_active_thread_id(
        self,
        frontend_kind: str,
        context_id: str,
        thread_id: str | None,
    ) -> None:
        self._conn.execute(
            """
            insert into frontend_contexts (frontend_kind, context_id, active_thread_id)
            values (?, ?, ?)
            on conflict(frontend_kind, context_id)
            do update set
                active_thread_id = excluded.active_thread_id,
                updated_at = current_timestamp
            """,
            (frontend_kind, context_id, thread_id),
        )
        self._conn.commit()

    def remember_thread(
        self,
        thread_id: str,
        title: str | None = None,
        reasoning_effort: str | None = None,
    ) -> None:
        self._conn.execute(
            """
            insert into known_threads (thread_id, title, reasoning_effort)
            values (?, ?, ?)
            on conflict(thread_id)
            do update set
                title = coalesce(excluded.title, known_threads.title),
                reasoning_effort = coalesce(excluded.reasoning_effort, known_threads.reasoning_effort),
                last_used_at = current_timestamp
            """,
            (thread_id, title, reasoning_effort),
        )
        self._conn.commit()

    def rename_thread(self, thread_id: str, title: str) -> None:
        self._conn.execute(
            """
            insert into known_threads (thread_id, title)
            values (?, ?)
            on conflict(thread_id)
            do update set
                title = excluded.title,
                last_used_at = current_timestamp
            """,
            (thread_id, title),
        )
        self._conn.commit()

    def set_thread_reasoning_effort(self, thread_id: str, reasoning_effort: str) -> None:
        self._conn.execute(
            """
            insert into known_threads (thread_id, reasoning_effort)
            values (?, ?)
            on conflict(thread_id)
            do update set
                reasoning_effort = excluded.reasoning_effort,
                last_used_at = current_timestamp
            """,
            (thread_id, reasoning_effort),
        )
        self._conn.commit()

    def list_known_threads(self, limit: int = 15) -> list[KnownThread]:
        rows = self._conn.execute(
            """
            select thread_id, title, reasoning_effort
            from known_threads
            order by last_used_at desc, created_at desc
            limit ?
            """,
            (limit,),
        ).fetchall()
        return [
            KnownThread(
                thread_id=row["thread_id"],
                title=row["title"],
                reasoning_effort=row["reasoning_effort"],
            )
            for row in rows
        ]

    def find_known_threads(self, selector: str, limit: int = 50) -> list[KnownThread]:
        lowered = selector.strip().lower()
        matches: list[KnownThread] = []

        for thread in self.list_known_threads(limit=limit):
            if thread.thread_id == selector:
                return [thread]
            if thread.thread_id.startswith(selector):
                matches.append(thread)
                continue
            if thread.title and lowered in thread.title.lower():
                matches.append(thread)

        return matches

    def get_known_thread(self, thread_id: str) -> KnownThread | None:
        row = self._conn.execute(
            """
            select thread_id, title, reasoning_effort
            from known_threads
            where thread_id = ?
            """,
            (thread_id,),
        ).fetchone()
        if row is None:
            return None
        return KnownThread(
            thread_id=row["thread_id"],
            title=row["title"],
            reasoning_effort=row["reasoning_effort"],
        )

    def _ensure_column(self, table_name: str, column_name: str, column_sql: str) -> None:
        rows = self._conn.execute(f"pragma table_info({table_name})").fetchall()
        existing = {row["name"] for row in rows}
        if column_name in existing:
            return
        self._conn.execute(f"alter table {table_name} add column {column_name} {column_sql}")

    def close(self) -> None:
        self._conn.close()
