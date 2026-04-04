from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import tomllib
from typing import Any

REASONING_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh")
APPROVAL_POLICIES = ("untrusted", "on-failure", "on-request", "never")
SANDBOX_MODES = ("read-only", "workspace-write", "danger-full-access")


def _env_flag(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(slots=True)
class Settings:
    codex_bin: str
    codex_model: str
    codex_personality: str
    codex_base_instructions: str | None
    codex_developer_instructions: str | None
    codex_reasoning_effort: str
    codex_approval_policy: str
    codex_sandbox_mode: str
    db_path: Path
    telegram_bot_token: str | None
    allowed_telegram_user_id: int | None
    tui_context_id: str
    open_browser_on_login: bool

    @classmethod
    def load(cls) -> "Settings":
        config_path = _default_config_path()
        config = _read_config(config_path)

        raw_user_id = _env_or_config(
            "ASTRA_ALLOWED_TELEGRAM_USER_ID",
            _nested_get(config, "telegram", "allowed_user_id"),
        )
        return cls(
            codex_bin=_string_value(
                _env_or_config("ASTRA_CODEX_BIN", _nested_get(config, "codex", "bin")),
                default="codex",
            ),
            codex_model=_string_value(
                _env_or_config("ASTRA_CODEX_MODEL", _nested_get(config, "codex", "model")),
                default="gpt-5.4",
            ),
            codex_personality=_string_value(
                _env_or_config("ASTRA_CODEX_PERSONALITY", _nested_get(config, "codex", "personality")),
                default="friendly",
            ),
            codex_base_instructions=_optional_string(
                _env_or_config(
                    "ASTRA_CODEX_BASE_INSTRUCTIONS",
                    _nested_get(config, "codex", "base_instructions"),
                )
            ),
            codex_developer_instructions=_optional_string(
                _env_or_config(
                    "ASTRA_CODEX_DEVELOPER_INSTRUCTIONS",
                    _nested_get(config, "codex", "developer_instructions"),
                )
            ),
            codex_reasoning_effort=_choice_value(
                _env_or_config(
                    "ASTRA_CODEX_REASONING_EFFORT",
                    _nested_get(config, "codex", "reasoning_effort"),
                ),
                default="high",
                choices=REASONING_EFFORTS,
                label="codex reasoning effort",
            ),
            codex_approval_policy=_choice_value(
                _env_or_config(
                    "ASTRA_CODEX_APPROVAL_POLICY",
                    _nested_get(config, "codex", "approval_policy"),
                ),
                default="never",
                choices=APPROVAL_POLICIES,
                label="codex approval policy",
            ),
            codex_sandbox_mode=_choice_value(
                _env_or_config(
                    "ASTRA_CODEX_SANDBOX_MODE",
                    _nested_get(config, "codex", "sandbox_mode"),
                ),
                default="danger-full-access",
                choices=SANDBOX_MODES,
                label="codex sandbox mode",
            ),
            db_path=_path_value(
                _env_or_config("ASTRA_DB_PATH", _nested_get(config, "app", "db_path")),
                config_path=config_path,
                default=".astra/astra.db",
            ),
            telegram_bot_token=_optional_string(
                _env_or_config("TELEGRAM_BOT_TOKEN", _nested_get(config, "telegram", "bot_token"))
            ),
            allowed_telegram_user_id=_optional_int(raw_user_id),
            tui_context_id=_string_value(
                _env_or_config("ASTRA_TUI_CONTEXT_ID", _nested_get(config, "app", "tui_context_id")),
                default="local",
            ),
            open_browser_on_login=_bool_value(
                env_name="ASTRA_OPEN_BROWSER_ON_LOGIN",
                config_value=_nested_get(config, "app", "open_browser_on_login"),
                default=True,
            ),
        )


def _default_config_path() -> Path:
    explicit = os.getenv("ASTRA_CONFIG_PATH")
    if explicit:
        return Path(explicit)
    return Path("astra.toml")


def _read_config(config_path: Path) -> dict[str, Any]:
    if not config_path.exists():
        return {}
    with config_path.open("rb") as handle:
        data = tomllib.load(handle)
    if not isinstance(data, dict):
        return {}
    return data


def _nested_get(data: dict[str, Any], *keys: str) -> Any:
    current: Any = data
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
        if current is None:
            return None
    return current


def _env_or_config(env_name: str, config_value: Any) -> Any:
    env_value = os.getenv(env_name)
    if env_value is not None:
        return env_value
    return config_value


def _string_value(value: Any, default: str) -> str:
    normalized = _optional_string(value)
    if normalized is None:
        return default
    return normalized


def _optional_string(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text


def _optional_int(value: Any) -> int | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return int(text)


def _bool_value(env_name: str, config_value: Any, default: bool) -> bool:
    if os.getenv(env_name) is not None:
        return _env_flag(env_name, default)
    if config_value is None:
        return default
    if isinstance(config_value, bool):
        return config_value
    return str(config_value).strip().lower() in {"1", "true", "yes", "on"}


def _path_value(value: Any, config_path: Path, default: str) -> Path:
    raw = _string_value(value, default=default)
    path = Path(raw)
    if path.is_absolute():
        return path
    return config_path.parent.joinpath(path)


def _choice_value(value: Any, default: str, choices: tuple[str, ...], label: str) -> str:
    normalized = _string_value(value, default=default).lower()
    if normalized not in choices:
        options = ", ".join(choices)
        raise ValueError(f"Invalid {label}: {normalized!r}. Expected one of: {options}")
    return normalized
