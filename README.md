# Astra

Astra is a local-first Python app that lets you use Codex from either:

- A local web app with a vault, agents, and scheduled jobs
- Telegram
- A local terminal REPL

Both frontends share the same core logic and the same Codex thread model, so switching threads works the same way everywhere.

## Why this MVP is simple

- `codex app-server` owns auth and long-lived thread history
- Astra stores frontend mappings, vault metadata, agents, jobs, and run history in SQLite
- The local web app keeps the knowledge base as normal files on disk
- Telegram, the terminal REPL, and the web app all share the same Codex bridge

## Architecture

```text
Web UI / Telegram / TUI
        |
        v
   Astra app
        |
        +-- Codex bridge
        +-- vault + search index
        +-- agent runtime
        +-- scheduler
        +-- SQLite state
        |
        v
  codex app-server
        |
        v
ChatGPT auth + durable Codex threads
```

## Web app features

- Local filesystem vault for markdown notes and attachments
- Search backed by SQLite FTS
- Per-agent Codex threads with scoped working directories
- Manual quick runs and reusable jobs
- Heartbeat-style scheduled jobs
- Run history with touched-file tracking

## Commands

These commands behave the same in Telegram and the local REPL unless noted:

- `/help` show help
- `/login` start ChatGPT login and print the auth URL
- `/whoami` show Telegram ids for bot lock-down (`Telegram` only)
- `/logout` sign out of Codex app-server
- `/status` show auth state and the active thread
- `/new [title]` create and switch to a new thread
- `/clear` alias for `/new`
- `/effort [value]` show or set thread reasoning effort
- `/threads` list recent Astra-known threads
- `/use <thread-id-prefix-or-title>` switch to an existing thread
- `/rename <title>` rename the active thread
- `/archive` archive the active thread and clear the active mapping
- `/exit` or `/quit` leave the local REPL

Plain text sends a normal user message to the active thread. If there is no active thread yet, Astra creates one automatically.

## Important auth note

`codex app-server`'s ChatGPT login flow uses a localhost callback. In practice, that means `/login` works best when you open the auth URL from the same machine that is running Astra.

For that reason, the easiest MVP flow is:

1. Run `astra tui`
2. Use `/login`
3. Once logged in, use either the REPL or Telegram

## Setup

1. Install dependencies:

```bash
uv sync
```

2. Create a local config file:

```bash
cp astra.toml.example astra.toml
```

Then edit `astra.toml`. A minimal example:

```toml
[app]
db_path = ".astra/astra.db"
tui_context_id = "local"
open_browser_on_login = true

[web]
host = "127.0.0.1"
port = 8765
open_browser = true
scheduler_poll_seconds = 10
agent_approval_policy = "never"
agent_sandbox_mode = "workspace-write"

[vault]
path = ".astra/vault"
inbox_dir = "Inbox"

[codex]
bin = "codex"
model = "gpt-5.4"
personality = "friendly"
reasoning_effort = "high"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[telegram]
bot_token = "paste-your-bot-token-here"
# allowed_user_id = 123456789
```

Optional prompt overrides live in the same file under `[codex]`:

```toml
base_instructions = """
You are my personal Codex Telegram bridge.
"""

developer_instructions = """
Keep replies concise unless I ask for depth.
"""
```

`reasoning_effort` defaults to `high`. You can override it per thread at runtime with `/effort low`, `/effort medium`, `/effort high`, or `/effort xhigh`.

`[web].agent_sandbox_mode = "workspace-write"` is the safer default for vault agents because it keeps them inside the working tree. The broader `codex.sandbox_mode` setting still applies to the TUI and Telegram flows.

Environment variables still work and override `astra.toml` when set. If you want a different config location, set `ASTRA_CONFIG_PATH`.

## Run

Start the local web app:

```bash
uv run astra web
```

Start the local REPL:

```bash
uv run astra tui
```

Start the Telegram bot:

```bash
uv run astra telegram
```

## Telegram lock-down

Run the bot once, then message it:

```text
/whoami
```

Take the returned `user_id` and set it in `astra.toml`:

```toml
[telegram]
bot_token = "paste-your-bot-token-here"
allowed_user_id = 123456789
```

Then restart the bot.

## Project layout

```text
src/astra/
  agent_runtime.py
  cli.py
  events.py
  settings.py
  state.py
  app_server.py
  service.py
  vault.py
  web.py
  web_state.py
  frontends/
    tui.py
    telegram_bot.py
  static/
  templates/
```
