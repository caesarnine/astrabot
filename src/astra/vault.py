from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
import re
import time
from typing import Any

from .web_state import WebStateStore

_TEXT_SUFFIXES = {
    ".css",
    ".html",
    ".js",
    ".json",
    ".md",
    ".mdx",
    ".py",
    ".rst",
    ".sh",
    ".sql",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}


@dataclass(slots=True)
class VaultDocument:
    path: str
    kind: str
    title: str
    editable: bool
    content: str | None


class VaultManager:
    def __init__(self, vault_path: Path, inbox_dir: str, store: WebStateStore) -> None:
        self._vault_path = vault_path.resolve()
        self._inbox_dir = self._normalize_rel_path(inbox_dir)
        self._store = store
        self._last_sync_ns = 0

    @property
    def vault_path(self) -> Path:
        return self._vault_path

    @property
    def inbox_dir(self) -> str:
        return self._inbox_dir

    def initialize(self) -> None:
        self._vault_path.mkdir(parents=True, exist_ok=True)
        self.resolve_dir(self._inbox_dir).mkdir(parents=True, exist_ok=True)
        if not any(path.is_file() for path in self._vault_path.rglob("*")):
            welcome = self._vault_path / "Getting-Started.md"
            welcome.write_text(
                "# Welcome to Astra\n\n"
                "This vault is local-first.\n\n"
                "- Create notes from the editor.\n"
                "- Add agents in the right panel.\n"
                "- Give each agent a scope and heartbeat job.\n"
                "- Let agents write durable notes back into the vault.\n",
                encoding="utf-8",
            )
        self.sync_index(force=True)

    def sync_index(self, *, force: bool = False) -> None:
        now_ns = self._timestamp_ns()
        if not force and now_ns - self._last_sync_ns < 2_000_000_000:
            return

        seen_paths: set[str] = set()
        for path in self._walk_paths():
            relative = self.to_rel_path(path)
            seen_paths.add(relative)
            stat = path.stat()
            kind = "dir" if path.is_dir() else "file"
            title = path.name if path != self._vault_path else self._vault_path.name
            body = ""
            sha256 = None
            size_bytes = stat.st_size if path.is_file() else None
            if path.is_file():
                body, sha256 = self._indexable_body(path)
                title = self._extract_title(relative, body)
            self._store.upsert_document(
                path=relative,
                kind=kind,
                title=title,
                sha256=sha256,
                size_bytes=size_bytes,
                mtime_ns=stat.st_mtime_ns,
                body=body,
            )

        self._store.remove_documents_not_in(seen_paths)
        self._last_sync_ns = now_ns

    def list_tree(self) -> dict[str, Any]:
        self.sync_index()
        root = {"name": self._vault_path.name, "path": "", "kind": "dir", "children": []}
        for path in self._walk_paths(include_root=False):
            parts = list(Path(self.to_rel_path(path)).parts)
            current = root
            accumulated: list[str] = []
            for index, part in enumerate(parts):
                accumulated.append(part)
                rel_path = "/".join(accumulated)
                kind = "dir" if index < len(parts) - 1 or path.is_dir() else "file"
                existing = next((child for child in current["children"] if child["path"] == rel_path), None)
                if existing is None:
                    existing = {"name": part, "path": rel_path, "kind": kind, "children": []}
                    current["children"].append(existing)
                    current["children"].sort(key=lambda item: (item["kind"] != "dir", item["name"].lower()))
                current = existing
        return root

    def read_document(self, rel_path: str) -> VaultDocument:
        self.sync_index()
        path = self.resolve_path(rel_path)
        if path.is_dir():
            return VaultDocument(path=self.to_rel_path(path), kind="dir", title=path.name, editable=False, content=None)

        editable = self.is_text_file(path)
        content = path.read_text(encoding="utf-8") if editable else None
        return VaultDocument(
            path=self.to_rel_path(path),
            kind="file",
            title=self._extract_title(self.to_rel_path(path), content or ""),
            editable=editable,
            content=content,
        )

    def save_document(self, rel_path: str, content: str) -> VaultDocument:
        path = self.resolve_path(rel_path)
        if path.is_dir():
            raise ValueError("Directories cannot be edited.")
        if not self.is_text_file(path):
            raise ValueError("This file type is not editable in the MVP editor.")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        self.sync_index(force=True)
        return self.read_document(rel_path)

    def create_note(self, parent: str, name: str) -> VaultDocument:
        safe_parent = self._normalize_rel_path(parent)
        safe_name = self._slugify_name(name)
        rel_path = safe_name if not safe_parent else f"{safe_parent}/{safe_name}"
        path = self.resolve_path(rel_path)
        if path.exists():
            raise ValueError(f"{rel_path} already exists.")
        title = Path(rel_path).stem.replace("-", " ").strip().title() or "Untitled"
        body = f"# {title}\n\n"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
        self.sync_index(force=True)
        return self.read_document(rel_path)

    def ensure_note(self, rel_path: str, title: str, body: str) -> str:
        normalized = self._normalize_rel_path(rel_path)
        path = self.resolve_path(normalized)
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            scaffold = f"# {title}\n\n{body}".rstrip() + "\n"
            path.write_text(scaffold, encoding="utf-8")
            self.sync_index(force=True)
        return normalized

    def search(self, query: str) -> list[dict[str, str | None]]:
        self.sync_index()
        return [
            {"path": item.path, "title": item.title, "snippet": item.snippet}
            for item in self._store.search_documents(query)
        ]

    def snapshot_scope(self, rel_scope_path: str) -> dict[str, int]:
        scope_path = self.resolve_dir(rel_scope_path)
        snapshot: dict[str, int] = {}
        for path in self._walk_paths(start=scope_path, include_root=False):
            if path.is_file():
                snapshot[self.to_rel_path(path)] = path.stat().st_mtime_ns
        return snapshot

    def diff_snapshots(self, before: dict[str, int], after: dict[str, int]) -> list[str]:
        changed: list[str] = []
        seen = sorted(set(before) | set(after))
        for path in seen:
            if before.get(path) != after.get(path):
                changed.append(path)
        return changed

    def resolve_path(self, rel_path: str) -> Path:
        normalized = self._normalize_rel_path(rel_path)
        candidate = (self._vault_path / normalized).resolve()
        candidate.relative_to(self._vault_path)
        return candidate

    def resolve_dir(self, rel_path: str) -> Path:
        path = self.resolve_path(rel_path)
        if path.exists() and not path.is_dir():
            raise ValueError(f"{rel_path} is not a directory.")
        return path

    def to_rel_path(self, path: Path) -> str:
        relative = path.resolve().relative_to(self._vault_path)
        if str(relative) == ".":
            return ""
        return relative.as_posix()

    def is_text_file(self, path: Path) -> bool:
        if path.suffix.lower() in _TEXT_SUFFIXES:
            return True
        try:
            raw = path.read_bytes()[:1024]
        except OSError:
            return False
        return b"\x00" not in raw

    def _walk_paths(
        self,
        *,
        start: Path | None = None,
        include_root: bool = True,
    ) -> list[Path]:
        base = (start or self._vault_path).resolve()
        paths: list[Path] = []
        if include_root:
            paths.append(base)
        for path in sorted(base.rglob("*")):
            if any(part.startswith(".") for part in path.relative_to(self._vault_path).parts):
                continue
            paths.append(path)
        return paths

    def _indexable_body(self, path: Path) -> tuple[str, str | None]:
        if not self.is_text_file(path):
            return "", None
        data = path.read_bytes()
        sha256 = hashlib.sha256(data).hexdigest()
        try:
            body = data.decode("utf-8")
        except UnicodeDecodeError:
            body = data.decode("utf-8", errors="replace")
        return body, sha256

    def _extract_title(self, rel_path: str, body: str) -> str:
        match = re.search(r"^\s*#\s+(.+)$", body, flags=re.MULTILINE)
        if match:
            return match.group(1).strip()
        return Path(rel_path).stem.replace("-", " ").replace("_", " ").strip() or rel_path

    def _slugify_name(self, name: str) -> str:
        cleaned = re.sub(r"[^A-Za-z0-9._ -]+", "", name).strip()
        cleaned = cleaned.replace(" ", "-")
        if not cleaned:
            cleaned = "new-note"
        if not cleaned.endswith(".md"):
            cleaned = f"{cleaned}.md"
        return cleaned

    def _normalize_rel_path(self, rel_path: str) -> str:
        text = rel_path.strip().strip("/")
        if not text:
            return ""
        normalized = Path(text).as_posix()
        if normalized.startswith("../") or normalized == "..":
            raise ValueError("Path must stay inside the vault.")
        return normalized

    def _timestamp_ns(self) -> int:
        return time.monotonic_ns()
