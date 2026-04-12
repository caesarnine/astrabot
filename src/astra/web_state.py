from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import secrets
import sqlite3
from typing import Any


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
    active_turn_id: str | None = None


@dataclass(slots=True)
class JobRecord:
    id: str
    agent_id: str
    name: str
    prompt: str
    trigger_type: str
    interval_minutes: int | None
    cron_expression: str | None
    watch_path: str | None
    watch_debounce_seconds: int | None
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
    thread_id: str | None
    turn_id: str | None
    trigger: str
    status: str
    started_at: str
    finished_at: str | None
    summary_text: str | None
    error_text: str | None
    touched_paths: list[str]


@dataclass(slots=True)
class ActivityRecord:
    id: str
    agent_id: str
    job_id: str | None
    run_id: str | None
    thread_id: str | None
    turn_id: str | None
    kind: str
    status: str
    title: str
    body: str | None
    primary_path: str | None
    paths: list[str]
    metadata: dict[str, Any]
    created_at: str
    updated_at: str


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
                schedule_type text null,
                trigger_type text not null default 'interval',
                interval_minutes integer null,
                cron_expression text null,
                watch_path text null,
                watch_debounce_seconds integer null,
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
                thread_id text null,
                turn_id text null,
                trigger text not null,
                status text not null,
                started_at text not null,
                finished_at text null,
                summary_text text null,
                error_text text null,
                touched_paths_json text not null default '[]'
            );

            create table if not exists activity_items (
                id text not null primary key,
                agent_id text not null,
                job_id text null,
                run_id text null,
                thread_id text null,
                turn_id text null,
                kind text not null,
                status text not null,
                title text not null,
                body text null,
                primary_path text null,
                paths_json text not null default '[]',
                metadata_json text not null default '{}',
                created_at text not null,
                updated_at text not null
            );

            create index if not exists idx_activity_items_created_at on activity_items(created_at desc);
            create index if not exists idx_activity_items_kind_status on activity_items(kind, status);
            create index if not exists idx_activity_items_run_id on activity_items(run_id);
            create index if not exists idx_agent_runs_agent_started on agent_runs(agent_id, started_at desc);
            create index if not exists idx_agent_jobs_agent on agent_jobs(agent_id);
            """
        )
        self._ensure_column("agent_jobs", "trigger_type", "text not null default 'interval'")
        self._ensure_column("agent_jobs", "schedule_type", "text null")
        self._ensure_column("agent_jobs", "cron_expression", "text null")
        self._ensure_column("agent_jobs", "watch_path", "text null")
        self._ensure_column("agent_jobs", "watch_debounce_seconds", "integer null")
        self._ensure_column("agent_runs", "thread_id", "text null")
        self._ensure_column("agent_runs", "turn_id", "text null")
        self._ensure_column("agent_runs", "summary_text", "text null")
        legacy_rows = self._conn.execute("pragma table_info(agent_jobs)").fetchall()
        legacy_columns = {row["name"] for row in legacy_rows}
        if "schedule_type" in legacy_columns:
            self._conn.execute(
                """
                update agent_jobs
                set trigger_type = case
                    when schedule_type = 'interval' then 'interval'
                    when schedule_type = 'manual' then 'manual'
                    else coalesce(trigger_type, 'manual')
                end
                where trigger_type is null or trigger_type = ''
                """
            )
        run_rows = self._conn.execute("pragma table_info(agent_runs)").fetchall()
        run_columns = {row["name"] for row in run_rows}
        if "final_text" in run_columns:
            self._conn.execute(
                """
                update agent_runs
                set summary_text = coalesce(summary_text, final_text)
                where summary_text is null and final_text is not null
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
                    select r.turn_id
                    from agent_runs r
                    where r.agent_id = a.id and r.status = 'running'
                    order by r.started_at desc
                    limit 1
                ) as active_turn_id,
                (
                    select min(j.next_run_at)
                    from agent_jobs j
                    where j.agent_id = a.id and j.enabled = 1 and j.trigger_type in ('interval', 'cron')
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
                    select r.turn_id
                    from agent_runs r
                    where r.agent_id = a.id and r.status = 'running'
                    order by r.started_at desc
                    limit 1
                ) as active_turn_id,
                (
                    select min(j.next_run_at)
                    from agent_jobs j
                    where j.agent_id = a.id and j.enabled = 1 and j.trigger_type in ('interval', 'cron')
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

    def list_jobs(self, agent_id: str | None = None) -> list[JobRecord]:
        if agent_id is None:
            rows = self._conn.execute(
                """
                select *
                from agent_jobs
                order by lower(name)
                """
            ).fetchall()
        else:
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
        trigger_type: str,
        interval_minutes: int | None,
        cron_expression: str | None,
        watch_path: str | None,
        watch_debounce_seconds: int | None,
        next_run_at: str | None,
        enabled: bool,
    ) -> JobRecord:
        now_text = utc_now_text()
        job_id = _new_id("job")
        self._conn.execute(
            """
            insert into agent_jobs (
                id, agent_id, name, prompt, schedule_type, trigger_type, interval_minutes, cron_expression,
                watch_path, watch_debounce_seconds, next_run_at, last_run_at, enabled, created_at, updated_at
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?)
            """,
            (
                job_id,
                agent_id,
                name,
                prompt,
                trigger_type,
                trigger_type,
                interval_minutes,
                cron_expression,
                watch_path,
                watch_debounce_seconds,
                next_run_at,
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
        trigger_type: str,
        interval_minutes: int | None,
        cron_expression: str | None,
        watch_path: str | None,
        watch_debounce_seconds: int | None,
        next_run_at: str | None,
        enabled: bool,
    ) -> JobRecord:
        self._conn.execute(
            """
            update agent_jobs
            set
                name = ?,
                prompt = ?,
                schedule_type = ?,
                trigger_type = ?,
                interval_minutes = ?,
                cron_expression = ?,
                watch_path = ?,
                watch_debounce_seconds = ?,
                next_run_at = ?,
                enabled = ?,
                updated_at = ?
            where id = ?
            """,
            (
                name,
                prompt,
                trigger_type,
                trigger_type,
                interval_minutes,
                cron_expression,
                watch_path,
                watch_debounce_seconds,
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
                and trigger_type in ('interval', 'cron')
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
        thread_id: str | None = None,
    ) -> RunRecord:
        run_id = _new_id("run")
        started_at = utc_now_text()
        self._conn.execute(
            """
            insert into agent_runs (
                id, agent_id, job_id, thread_id, turn_id, trigger, status, started_at, finished_at,
                summary_text, error_text, touched_paths_json
            )
            values (?, ?, ?, ?, null, ?, 'queued', ?, null, null, null, '[]')
            """,
            (run_id, agent_id, job_id, thread_id, trigger, started_at),
        )
        self._conn.commit()
        return self.get_run(run_id)

    def set_run_turn(self, run_id: str, *, thread_id: str, turn_id: str) -> RunRecord:
        self._conn.execute(
            """
            update agent_runs
            set thread_id = ?, turn_id = ?
            where id = ?
            """,
            (thread_id, turn_id, run_id),
        )
        self._conn.commit()
        return self.get_run(run_id)

    def mark_run_running(self, run_id: str) -> RunRecord:
        self._conn.execute(
            "update agent_runs set status = 'running' where id = ?",
            (run_id,),
        )
        self._conn.commit()
        return self.get_run(run_id)

    def finish_run(
        self,
        run_id: str,
        *,
        status: str,
        summary_text: str | None,
        error_text: str | None,
        touched_paths: list[str],
    ) -> RunRecord:
        self._conn.execute(
            """
            update agent_runs
            set
                status = ?,
                finished_at = ?,
                summary_text = ?,
                error_text = ?,
                touched_paths_json = ?
            where id = ?
            """,
            (status, utc_now_text(), summary_text, error_text, json.dumps(touched_paths), run_id),
        )
        self._conn.commit()
        return self.get_run(run_id)

    def list_runs(self, agent_id: str | None = None, limit: int = 50) -> list[RunRecord]:
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

    def create_activity(
        self,
        *,
        agent_id: str,
        kind: str,
        status: str,
        title: str,
        body: str | None,
        paths: list[str] | None = None,
        primary_path: str | None = None,
        metadata: dict[str, Any] | None = None,
        job_id: str | None = None,
        run_id: str | None = None,
        thread_id: str | None = None,
        turn_id: str | None = None,
    ) -> ActivityRecord:
        activity_id = _new_id("activity")
        now_text = utc_now_text()
        cleaned_paths = paths or []
        self._conn.execute(
            """
            insert into activity_items (
                id, agent_id, job_id, run_id, thread_id, turn_id, kind, status, title, body,
                primary_path, paths_json, metadata_json, created_at, updated_at
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                activity_id,
                agent_id,
                job_id,
                run_id,
                thread_id,
                turn_id,
                kind,
                status,
                title,
                body,
                primary_path,
                json.dumps(cleaned_paths),
                json.dumps(metadata or {}),
                now_text,
                now_text,
            ),
        )
        self._conn.commit()
        return self.get_activity(activity_id)

    def update_activity(
        self,
        activity_id: str,
        *,
        status: str | None = None,
        title: str | None = None,
        body: str | None = None,
        paths: list[str] | None = None,
        primary_path: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ActivityRecord:
        current = self.get_activity(activity_id)
        next_status = status or current.status
        next_title = title or current.title
        next_body = current.body if body is None else body
        next_paths = current.paths if paths is None else paths
        next_primary = current.primary_path if primary_path is None else primary_path
        next_metadata = current.metadata if metadata is None else metadata
        self._conn.execute(
            """
            update activity_items
            set
                status = ?,
                title = ?,
                body = ?,
                primary_path = ?,
                paths_json = ?,
                metadata_json = ?,
                updated_at = ?
            where id = ?
            """,
            (
                next_status,
                next_title,
                next_body,
                next_primary,
                json.dumps(next_paths),
                json.dumps(next_metadata),
                utc_now_text(),
                activity_id,
            ),
        )
        self._conn.commit()
        return self.get_activity(activity_id)

    def list_activity(
        self,
        *,
        limit: int = 100,
        since_text: str | None = None,
        include_attention: bool = True,
    ) -> list[ActivityRecord]:
        query = [
            "select * from activity_items",
            "where 1 = 1",
        ]
        params: list[Any] = []
        if since_text is not None:
            query.append("and created_at >= ?")
            params.append(since_text)
        if not include_attention:
            query.append("and kind != 'attention'")
        query.append("order by created_at desc limit ?")
        params.append(limit)
        rows = self._conn.execute("\n".join(query), params).fetchall()
        return [self._row_to_activity(row) for row in rows]

    def list_attention(self, *, status: str = "pending") -> list[ActivityRecord]:
        rows = self._conn.execute(
            """
            select *
            from activity_items
            where kind = 'attention' and status = ?
            order by created_at desc
            """,
            (status,),
        ).fetchall()
        return [self._row_to_activity(row) for row in rows]

    def get_activity(self, activity_id: str) -> ActivityRecord:
        row = self._conn.execute("select * from activity_items where id = ?", (activity_id,)).fetchone()
        if row is None:
            raise KeyError(activity_id)
        return self._row_to_activity(row)

    def recent_file_activity(self, *, since_text: str) -> dict[str, dict[str, Any]]:
        rows = self._conn.execute(
            """
            select *
            from activity_items
            where kind in ('artifact', 'attention') and created_at >= ?
            order by created_at desc
            """,
            (since_text,),
        ).fetchall()
        recent: dict[str, dict[str, Any]] = {}
        for row in rows:
            activity = self._row_to_activity(row)
            paths = activity.paths or ([activity.primary_path] if activity.primary_path else [])
            for path in paths:
                if not path or path in recent:
                    continue
                recent[path] = {
                    "activityId": activity.id,
                    "agentId": activity.agent_id,
                    "kind": activity.kind,
                    "status": activity.status,
                    "title": activity.title,
                    "createdAt": activity.created_at,
                }
        return recent

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
            active_turn_id=row["active_turn_id"] if "active_turn_id" in row.keys() else None,
        )

    def _row_to_job(self, row: sqlite3.Row) -> JobRecord:
        trigger_type = row["trigger_type"] if "trigger_type" in row.keys() else None
        if not trigger_type and "schedule_type" in row.keys():
            trigger_type = row["schedule_type"]
        return JobRecord(
            id=row["id"],
            agent_id=row["agent_id"],
            name=row["name"],
            prompt=row["prompt"],
            trigger_type=trigger_type or "manual",
            interval_minutes=row["interval_minutes"],
            cron_expression=row["cron_expression"] if "cron_expression" in row.keys() else None,
            watch_path=row["watch_path"] if "watch_path" in row.keys() else None,
            watch_debounce_seconds=row["watch_debounce_seconds"] if "watch_debounce_seconds" in row.keys() else None,
            next_run_at=row["next_run_at"],
            last_run_at=row["last_run_at"],
            enabled=bool(row["enabled"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def _row_to_run(self, row: sqlite3.Row) -> RunRecord:
        summary_text = row["summary_text"] if "summary_text" in row.keys() else None
        if summary_text is None and "final_text" in row.keys():
            summary_text = row["final_text"]
        return RunRecord(
            id=row["id"],
            agent_id=row["agent_id"],
            job_id=row["job_id"],
            thread_id=row["thread_id"] if "thread_id" in row.keys() else None,
            turn_id=row["turn_id"] if "turn_id" in row.keys() else None,
            trigger=row["trigger"],
            status=row["status"],
            started_at=row["started_at"],
            finished_at=row["finished_at"],
            summary_text=summary_text,
            error_text=row["error_text"],
            touched_paths=json.loads(row["touched_paths_json"] or "[]"),
        )

    def _row_to_activity(self, row: sqlite3.Row) -> ActivityRecord:
        return ActivityRecord(
            id=row["id"],
            agent_id=row["agent_id"],
            job_id=row["job_id"],
            run_id=row["run_id"],
            thread_id=row["thread_id"],
            turn_id=row["turn_id"],
            kind=row["kind"],
            status=row["status"],
            title=row["title"],
            body=row["body"],
            primary_path=row["primary_path"],
            paths=json.loads(row["paths_json"] or "[]"),
            metadata=json.loads(row["metadata_json"] or "{}"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def _ensure_column(self, table_name: str, column_name: str, column_sql: str) -> None:
        rows = self._conn.execute(f"pragma table_info({table_name})").fetchall()
        existing = {row["name"] for row in rows}
        if column_name in existing:
            return
        self._conn.execute(f"alter table {table_name} add column {column_name} {column_sql}")
