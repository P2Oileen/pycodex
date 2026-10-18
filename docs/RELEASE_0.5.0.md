# 0.5.0 release notes

These notes compare **0.5.0 with the tagged 0.4.0 release**, including the
changes shipped in 0.4.1–0.4.8. The main additions are multi-device workspace
routing, user-owned frontends, session-level directory and reasoning controls,
and more reliable conversation display and agent coordination.

## Multi-device workspaces and agent coordination

- `pycodex-ws` now includes the `pycodex-router` command. Devices connect
  outward using `pycodex-ws --listen-to`, allowing one browser page to
  reach workspaces on multiple machines.
- Router registration uses a persistent key distinct from the browser login
  password. Devices reconnect after interruptions and router restarts.
- The directory groups workspaces by device, collects unread workspaces in a
  separate panel, and supports saved device aliases and ordering.
- The workspace Runtime Info button inserts session and API references into
  the draft for the user to review and send, enabling agent-to-agent
  coordination. On POSIX, hosted workspaces also provide a private Unix socket
  for same-user access to local and registered-device session APIs.
- Router and device logins remain separate. Registered devices are trusted
  and share the router browser origin.

## User-owned workspace frontends

- An optional `workspace.html`, `custom.css` or ES-module `custom.js` in the
  server user's `~/.pycodex/frontend/` customizes the interface. Supporting
  assets live in the same directory; it is independent of `CODEX_HOME`.
- Refresh applies changes without restarting the server. `?builtin=1` bypasses
  all customizations, with a visible link to re-enable them.
- The settings button opens an Agent conversation for interface changes.
  The editable frontend owns its title, prompt, development guidance and
  browser language preferences.
- `POST api/sessions` accepts optional `title` and `prompt` strings for any
  frontend workflow. Empty requests still create ordinary empty sessions.
- Custom CSS keeps its precedence when the code editor loads lazily. Shared
  scope, refresh instructions and recovery links remain visible in chat.

## Session and model controls

- `/cd <directory>` changes an idle session's working directory without changing
  the process directory or other sessions. Subsequent tools and new subagents
  use that directory; existing processes keep their original directory.
  Workspace tabs persist their directories across server restarts.
- `/resume <session_id>` accepts a full session UUID, including archived sessions
  outside the recent-session list. Resuming by list number remains available.
- `/effort <value>` changes reasoning effort for the current idle session;
  `/effort default` restores the model default. The CLI shows the active model,
  effort and display-safe endpoint at startup.
- Child completion notifications reach the parent's next model request without
  requiring an explicit `wait_agent` call.

## Conversation and viewer improvements

- A collapsible session sidebar, desktop status rail and phone controls make
  multiple conversations easier to manage. Running and unread indicators are
  consistent across sessions, workspace lists and the router.
- Refresh and recovery navigation retain the selected session independently
  for each browser tab. Polling preserves existing chat DOM and reading position.
- Conversation display retains turns across compaction and resume, with
  compaction markers; the model still receives the compacted active history.
- Canvas file links open workspace views, Markdown preview links resolve
  relative to their source file, and Canvas refreshes no longer add browser
  history entries. Fullscreen controls and mobile code/diff selection and
  copying are improved.
- Workspace WebSockets reject cross-origin browser connections. Login request
  bodies are limited to 4 KiB, and login pages identify the target service.

## Upgrade from 0.4.0

- IPython integration, its tool and its automatic dependency are removed.
  The Feishu SDK is now optional: install `lark-oapi` explicitly when using
  `/link`. Without it, `/link` reports how to install it before accessing
  credentials or creating a connection.
- `/exit` and `/quit` are removed. Close the CLI with Ctrl+C or Ctrl+D; accepted
  work drains normally. Python integrations close their Runtime directly.
- Initial working directories belong in `ContextConfig(cwd=...)` or
  `build_agent(cwd=...)`. Built-in tool constructors, `get_tools` and `get_subagent_tools`
  no longer accept a default `cwd`. Direct tool calls must supply
  `ToolContext(turn_id, history, cwd)`, and direct unified-exec calls use
  `UnifiedExecManager.exec_command(cmd, cwd, ...)`.
- Custom clients used by interactive model controls now expose
  `reasoning_effort` and a display-safe `endpoint`. The base `ModelClient`
  contract remains `model` and `complete`.
- Runtime snapshots use `model:effort` as the model display label. The Agent
  and model client's actual model identifier is unchanged.

For a workspace installation, upgrading `pycodex-ws` installs the matching core:

```bash
python3 -m pip install --upgrade pycodex-ws==0.5.0
```

Core-only installations can upgrade `python-codex==0.5.0`. Python support remains
3.6.2+ for core and 3.7+ for workspace. Both packages retain universal wheels;
publish `python-codex` before `pycodex-ws`, which depends on exactly
`python-codex==0.5.0`. The VS Code extension is still distributed separately.

See the [runtime documentation](RUNTIME.md) for session, frontend and API contracts.
