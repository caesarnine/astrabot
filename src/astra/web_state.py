from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import secrets
import sqlite3


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_now_text() -> str:
    return utc_now().isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


@dataclass(slots=True)
class DocumentRecord:
    path: str
    kind: str
    title: str | None
    size_bytes: int | None
    mtime_ns: int


@dataclass(slots=True)
class SearchResult:
    path: str
    title: str | None
    snippet: str


@dataclass(slots=True)
class AgentRecord:
    id: str
    name: str
    prompt: str
    scope_path: str
    output_dir: str
    thread_id: str | None
    model: str
    reasoning_effort: str
    approval_policy: str
    sandbox_mode: str
    enabled: bool
    created_at: str
    updated_at: str
    last_run_at: str | None = None
    last_run_status: str | None = None
    next_run_at: str | None = None


@dataclass(slots=True)
class JobRecord:
    id: str
    agent_id: str
    name: str
    prompt: str
    schedule_type: str
    interval_minutes: int | None
    next_run_at: str | None
    last_run_at: str | None
    enabled: bool
    created_at: str
    updated_at: str


@dataclass(slots=True)
class RunRecord:
    id: str
    agent_id: str
    job_id: str | None
    trigger: str
    status: str
    started_at: str
    finished_at: str | None
    final_text: str | None
    error_text: str | None
    touched_paths: list[str]
    output_note_path: str | None


class WebStateStore:
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path)
        self._conn.row_factory = sqlite3.Row

    def initialize(self) -> None:
        self._conn.executescript(
            """
            create table if not exists vault_documents (
                path text not null primary key,
                kind text not null,
                title text null,
                sha256 text null,
                size_bytes integer null,
                mtime_ns integer not null,
                indexed_at text not null
            );

            create virtual table if not exists vault_document_fts
            using fts5(path, title, body);

            create table if not exists agents (
                id text not null primary key,
                name text not null,
                prompt text not null,
                scope_path text not null,
                output_dir text not null,
                thread_id text null,
                model text not null,
                reasoning_effort text not null,
                approval_policy text not null,
                sandbox_mode text not null,
                enabled integer not null default 1,
                created_at text not null,
                updated_at text not null
            );

            create table if not exists agent_jobs (
                id text not null primary key,
                agent_id text not null,
                name text not null,
                prompt text not null,
                schedule_type text not null,
                interval_minutes integer null,
                next_run_at text null,
                last_run_at text null,
                enabled integer not null default 1,
                created_at text not null,
                updated_at text not null
            );

            create table if not exists agent_runs (
                id text not null primary key,
                agent_id text not null,
                job_id text null,
                trigger text not null,
                status text not null,
                started_at text not null,
                finished_at text null,
                final_text text null,
                error_text text null,
                touched_paths_json text not null default '[]',
                output_note_path text null
            );
            """
        )
        self._conn.commit()

    def upsert_document(
        self,
        *,
        path: str,
        kind: str,
        title: str | None,
        sha256: str | None,
        size_bytes: int | None,
        mtime_ns: int,
        body: str,
    ) -> None:
        indexed_at = utc_now_text()
        self._conn.execute(
            """
            insert into vault_documents (path, kind, title, sha256, size_bytes, mtime_ns, indexed_at)
            values (?, ?, ?, ?, ?, ?, ?)
            on conflict(path)
            do update set
                kind = excluded.kind,
                title = excluded.title,
                sha256 = excluded.sha256,
                size_bytes = excluded.size_bytes,
                mtime_ns = excluded.mtime_ns,
                indexed_at = excluded.indexed_at
            """,
            (path, kind, title, sha256, size_bytes, mtime_ns, indexed_at),
        )
        self._conn.execute("delete from vault_document_fts where path = ?", (path,))
        self._conn.execute(
            "insert into vault_document_fts (path, title, body) values (?, ?, ?)",
            (path, title or "", body),
        )
        self._conn.commit()

    def remove_documents_not_in(self, paths: set[str]) -> None:
        rows = self._conn.execute("select path from vault_documents").fetchall()
        stale = [row["path"] for row in rows if row["path"] not in paths]
        if not stale:
            return
        self._conn.executemany("delete from vault_documents where path = ?", [(path,) for path in stale])
        self._conn.executemany("delete from vault_document_fts where path = ?", [(path,) for path in stale])
        self._conn.commit()

    def search_documents(self, query: str, limit: int = 20) -> list[SearchResult]:
        terms = re.findall(r"[A-Za-z0-9_]+", query)
        if not terms:
            return []
        rows = self._conn.execute(
            """
            select
                path,
                nullif(title, '') as title,
                snippet(vault_document_fts, 2, '<mark>', '</mark>', ' … ', 18) as snippet
            from vault_document_fts
            where vault_document_fts match ?
            order by rank
            limit ?
            """,
            (" ".join(terms), limit),
        ).fetchall()
        return [
            SearchResult(
                path=row["path"],
                title=row["title"],
                snippet=row["snippet"] or "",
            )
            for row in rows
        ]

    def create_agent(
        self,
        *,
        name: str,
        prompt: str,
        scope_path: str,
        output_dir: str,
        model: str,
        reasoning_effort: str,
        approval_policy: str,
        sandbox_mode: str,
        enabled: bool,
    ) -> AgentRecord:
        now = utc_now_text()
        agent_id = _new_id("agent")
        self._conn.execute(
            """
            insert into agents (
                id, name, prompt, scope_path, output_dir, thread_id, model,
                reasoning_effort, approval_policy, sandbox_mode, enabled, created_at, updated_at
            )
            values (?, ?, ?, ?, ?, null, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                agent_id,
                name,
                prompt,
                scope_path,
                output_dir,
                model,
                reasoning_effort,
                approval_policy,
                sandbox_mode,
                1 if enabled else 0,
                now,
                now,
            ),
        )
        self._conn.commit()
        return self.get_agent(agent_id)

    def list_agents(self) -> list[AgentRecord]:
        rows = self._conn.execute(
            """
            select
                a.*,
                (
                    select r.started_at
                    from agent_runs r
                    where r.agent_id = a.id
                    order by r.started_at desc
                    limit 1
                ) as last_run_at,
                (
                    select r.status
                    from agent_runs r
                    where r.agent_id = a.id
                    order by r.started_at desc
                    limit 1
                ) as last_run_status,
                (
                    select min(j.next_run_at)
                    from agent_jobs j
                    where j.agent_id = a.id and j.enabled = 1 and j.schedule_type = 'interval'
                ) as next_run_at
            from agents a
            order by lower(a.name)
            """
        ).fetchall()
        return [self._row_to_agent(row) for row in rows]

    def get_agent(self, agent_id: str) -> AgentRecord:
        row = self._conn.execute(
            """
            select
                a.*,
                (
                    select r.started_at
                    from agent_runs r
                    where r.agent_id = a.id
                    order by r.started_at desc
                    limit 1
                ) as last_run_at,
                (
                    select r.status
                    from agent_runs r
                    where r.agent_id = a.id
                    order by r.started_at desc
                    limit 1
                ) as last_run_status,
                (
                    select min(j.next_run_at)
                    from agent_jobs j
                    where j.agent_id = a.id and j.enabled = 1 and j.schedule_type = 'interval'
                ) as next_run_at
            from agents a
            where a.id = ?
            """,
            (agent_id,),
        ).fetchone()
        if row is None:
            raise KeyError(agent_id)
        return self._row_to_agent(row)

    def update_agent(
        self,
        agent_id: str,
        *,
        name: str,
        prompt: str,
        scope_path: str,
        output_dir: str,
        model: str,
        reasoning_effort: str,
        approval_policy: str,
        sandbox_mode: str,
        enabled: bool,
    ) -> AgentRecord:
        self._conn.execute(
            """
            update agents
            set
                name = ?,
                prompt = ?,
                scope_path = ?,
                output_dir = ?,
                model = ?,
                reasoning_effort = ?,
                approval_policy = ?,
                sandbox_mode = ?,
                enabled = ?,
                updated_at = ?
            where id = ?
            """,
            (
                name,
                prompt,
                scope_path,
                output_dir,
                model,
                reasoning_effort,
                approval_policy,
                sandbox_mode,
                1 if enabled else 0,
                utc_now_text(),
                agent_id,
            ),
        )
        self._conn.commit()
        return self.get_agent(agent_id)

    def set_agent_thread_id(self, agent_id: str, thread_id: str) -> None:
        self._conn.execute(
            "update agents set thread_id = ?, updated_at = ? where id = ?",
            (thread_id, utc_now_text(), agent_id),
        )
        self._conn.commit()

    def list_jobs(self, agent_id: str) -> list[JobRecord]:
        rows = self._conn.execute(
            """
            select *
            from agent_jobs
            where agent_id = ?
            order by lower(name)
            """,
            (agent_id,),
        ).fetchall()
        return [self._row_to_job(row) for row in rows]

    def get_job(self, job_id: str) -> JobRecord:
        row = self._conn.execute("select * from agent_jobs where id = ?", (job_id,)).fetchone()
        if row is None:
            raise KeyError(job_id)
        return self._row_to_job(row)

    def create_job(
        self,
        *,
        agent_id: str,
        name: str,
        prompt: str,
        schedule_type: str,
        interval_minutes: int | None,
        enabled: bool,
    ) -> JobRecord:
        now = utc_now()
        next_run_at = None
        if schedule_type == "interval" and enabled and interval_minutes:
            next_run_at = (now.timestamp() + interval_minutes * 60)
            next_run_text = datetime.fromtimestamp(next_run_at, timezone.utc).isoformat()
        else:
            next_run_text = None

        job_id = _new_id("job")
        now_text = now.isoformat()
        self._conn.execute(
            """
            insert into agent_jobs (
                id, agent_id, name, prompt, schedule_type, interval_minutes, next_run_at,
                last_run_at, enabled, created_at, updated_at
            )
            values (?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?)
            """,
            (
                job_id,
                agent_id,
                name,
                prompt,
                schedule_type,
                interval_minutes,
                next_run_text,
                1 if enabled else 0,
                now_text,
                now_text,
            ),
        )
        self._conn.commit()
        return self.get_job(job_id)

    def update_job(
        self,
        job_id: str,
        *,
        name: str,
        prompt: str,
        schedule_type: str,
        interval_minutes: int | None,
        enabled: bool,
    ) -> JobRecord:
        existing = self.get_job(job_id)
        next_run_at = existing.next_run_at
        if schedule_type != "interval" or not enabled:
            next_run_at = None
        elif interval_minutes:
            now_text = utc_now_text()
            if existing.schedule_type != "interval" or existing.interval_minutes != interval_minutes or not existing.enabled:
                next_run_at = now_text

        self._conn.execute(
            """
            update agent_jobs
            set
                name = ?,
                prompt = ?,
                schedule_type = ?,
                interval_minutes = ?,
                next_run_at = ?,
                enabled = ?,
                updated_at = ?
            where id = ?
            """,
            (
                name,
                prompt,
                schedule_type,
                interval_minutes,
                next_run_at,
                1 if enabled else 0,
                utc_now_text(),
                job_id,
            ),
        )
        self._conn.commit()
        return self.get_job(job_id)

    def set_job_run_state(self, job_id: str, *, last_run_at: str, next_run_at: str | None) -> None:
        self._conn.execute(
            """
            update agent_jobs
            set
                last_run_at = ?,
                next_run_at = ?,
                updated_at = ?
            where id = ?
            """,
            (last_run_at, next_run_at, utc_now_text(), job_id),
        )
        self._conn.commit()

    def list_due_jobs(self, now_text: str, limit: int = 20) -> list[JobRecord]:
        rows = self._conn.execute(
            """
            select *
            from agent_jobs
            where
                enabled = 1
                and schedule_type = 'interval'
                and next_run_at is not null
                and next_run_at <= ?
            order by next_run_at
            limit ?
            """,
            (now_text, limit),
        ).fetchall()
        return [self._row_to_job(row) for row in rows]

    def create_run(
        self,
        *,
        agent_id: str,
        job_id: str | None,
        trigger: str,
        output_note_path: str | None,
    ) -> RunRecord:
        run_id = _new_id("run")
        started_at = utc_now_text()
        self._conn.execute(
            """
            insert into agent_runs (
                id, agent_id, job_id, trigger, status, started_at, finished_at,
                final_text, error_text, touched_paths_json, output_note_path
            )
            values (?, ?, ?, ?, 'queued', ?, null, null, null, '[]', ?)
            """,
            (run_id, agent_id, job_id, trigger, started_at, output_note_path),
        )
        self._conn.commit()
        return self.get_run(run_id)

    def mark_run_running(self, run_id: str) -> None:
        self._conn.execute(
            "update agent_runs set status = 'running' where id = ?",
            (run_id,),
        )
        self._conn.commit()

    def finish_run(
        self,
        run_id: str,
        *,
        status: str,
        final_text: str | None,
        error_text: str | None,
        touched_paths: list[str],
    ) -> RunRecord:
        self._conn.execute(
            """
            update agent_runs
            set
                status = ?,
                finished_at = ?,
                final_text = ?,
                error_text = ?,
                touched_paths_json = ?
            where id = ?
            """,
            (status, utc_now_text(), final_text, error_text, json.dumps(touched_paths), run_id),
        )
        self._conn.commit()
        return self.get_run(run_id)

    def list_runs(self, agent_id: str | None = None, limit: int = 25) -> list[RunRecord]:
        if agent_id is None:
            rows = self._conn.execute(
                """
                select *
                from agent_runs
                order by started_at desc
                limit ?
                """,
                (limit,),
            ).fetchall()
        else:
            rows = self._conn.execute(
                """
                select *
                from agent_runs
                where agent_id = ?
                order by started_at desc
                limit ?
                """,
                (agent_id, limit),
            ).fetchall()
        return [self._row_to_run(row) for row in rows]

    def get_run(self, run_id: str) -> RunRecord:
        row = self._conn.execute("select * from agent_runs where id = ?", (run_id,)).fetchone()
        if row is None:
            raise KeyError(run_id)
        return self._row_to_run(row)

    def close(self) -> None:
        self._conn.close()

    def _row_to_agent(self, row: sqlite3.Row) -> AgentRecord:
        return AgentRecord(
            id=row["id"],
            name=row["name"],
            prompt=row["prompt"],
            scope_path=row["scope_path"],
            output_dir=row["output_dir"],
            thread_id=row["thread_id"],
            model=row["model"],
            reasoning_effort=row["reasoning_effort"],
            approval_policy=row["approval_policy"],
            sandbox_mode=row["sandbox_mode"],
            enabled=bool(row["enabled"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            last_run_at=row["last_run_at"] if "last_run_at" in row.keys() else None,
            last_run_status=row["last_run_status"] if "last_run_status" in row.keys() else None,
            next_run_at=row["next_run_at"] if "next_run_at" in row.keys() else None,
        )

    def _row_to_job(self, row: sqlite3.Row) -> JobRecord:
        return JobRecord(
            id=row["id"],
            agent_id=row["agent_id"],
            name=row["name"],
            prompt=row["prompt"],
            schedule_type=row["schedule_type"],
            interval_minutes=row["interval_minutes"],
            next_run_at=row["next_run_at"],
            last_run_at=row["last_run_at"],
            enabled=bool(row["enabled"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def _row_to_run(self, row: sqlite3.Row) -> RunRecord:
        return RunRecord(
            id=row["id"],
            agent_id=row["agent_id"],
            job_id=row["job_id"],
            trigger=row["trigger"],
            status=row["status"],
            started_at=row["started_at"],
            finished_at=row["finished_at"],
            final_text=row["final_text"],
            error_text=row["error_text"],
            touched_paths=json.loads(row["touched_paths_json"] or "[]"),
            output_note_path=row["output_note_path"],
        )
