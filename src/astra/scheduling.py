from __future__ import annotations

from datetime import datetime, timedelta, timezone

from croniter import croniter

from .web_state import JobRecord


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def next_job_run_at(job: JobRecord, *, from_time: datetime | None = None) -> str | None:
    now = from_time or utc_now()
    if not job.enabled:
        return None
    if job.trigger_type == "interval":
        if not job.interval_minutes:
            return None
        return (now + timedelta(minutes=job.interval_minutes)).isoformat()
    if job.trigger_type == "cron":
        if not job.cron_expression:
            return None
        return croniter(job.cron_expression, now).get_next(datetime).astimezone(timezone.utc).isoformat()
    return None


def cron_preview(expression: str | None) -> str | None:
    if not expression:
        return None
    parts = expression.split()
    if len(parts) != 5:
        return expression
    minute, hour, dom, month, dow = parts
    if dom == "*" and month == "*" and dow == "*":
        if minute.isdigit() and hour.isdigit():
            return f"Daily at {int(hour):02d}:{int(minute):02d}"
    return expression
