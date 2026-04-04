# Astra

Astra is a very small Python bridge that lets you talk to Codex from either:

- Telegram
- A local terminal REPL

Both frontends share the same core logic and the same Codex thread model, so switching threads works the same way everywhere.

## Why this MVP is simple

- `codex app-server` owns auth and long-lived thread history
- Astra only stores frontend-to-thread mappings and a small thread index in SQLite
- Telegram and the terminal REPL both call the same service layer
- There is no web server in v0

## Architecture

```text
Telegram / TUI
      |
      v
  Astra service
      |
      +-- command parser
      +-- active-thread router
      +-- SQLite context mappings
      |
      v
codex app-server
      |
      v
ChatGPT auth + durable Codex threads
```

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

`approval_policy = "never"` and `sandbox_mode = "danger-full-access"` make Astra run Codex with no approval prompts and no sandbox restrictions by default. This is intentionally powerful and is best used on a dedicated machine, VM, or isolated Unix user that you trust.

Environment variables still work and override `astra.toml` when set. If you want a different config location, set `ASTRA_CONFIG_PATH`.

## Run

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
  cli.py
  settings.py
  state.py
  app_server.py
  service.py
  frontends/
    tui.py
    telegram_bot.py
```
