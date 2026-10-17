# pycodex-ws

Browser conversations, a live HTML Canvas, read-only file/diff viewers and
optional Feishu integration for
[`python-codex`](https://pypi.org/project/python-codex/).
Requires Python 3.7+ and installs the matching core version.

## Quick start

```bash
python3 -m pip install pycodex-ws
```

Create `workspaces.json`:

```json
{
  "workspaces": [
    {"id": "demo", "work_dir": ".", "state_path": "demo", "enable_board": true}
  ]
}
```

```bash
pycodex-ws --listen 127.0.0.1:6007 --workspace-config workspaces.json
```

Open `http://127.0.0.1:6007`. Use `python3 -m workspace_server` if the command
is not on `PATH`. Keep stdin open while the server runs; EOF initiates shutdown.
Model configuration comes from `~/.codex/config.toml`.

## Conversations and views

The session sidebar starts collapsed. Hover to preview it, click to keep it
open, and click the toggle or empty space again to close it. Expansion narrows
the conversation while keeping the board fixed. On phones, use the header
buttons to switch between chat and board.

Use the expanded sidebar to create, rename or close sessions. Status dots show
running sessions and unread replies. `/cd <directory>` changes the current
session's working directory while idle; `/model`, `/resume`, `/compact` and
other core session commands are also available.

Click Markdown links to open files and comparisons, for example
`[source](app.py:42)` or `[changes](diff:HEAD:app.py)`. In a code or diff view,
select text and choose **Insert into chat** to add editable context to the draft.
Click a context block to edit or remove it before sending.
See [view links and supported formats](../../docs/RUNTIME.md#workspace-content-views).

When using a router, its directory groups workspaces by device and lists unread
workspaces at the top. Device handles reorder the list; pencil buttons edit
device names.

The [VS Code extension](extensions/vscode/README.md) uses this backend and is
distributed separately as a VSIX.

## Storage

Paths in `workspaces.json` resolve from the configuration directory.
`state_path` is a unique filename prefix: the example saves sessions in
`demo.pycodex-ws.json`, file views in `demo.pycodex-views.json`, and Canvas in
`demo.html`. Suffixes are appended to the complete prefix, including any dots.

Set `enable_board` to `false` to disable Canvas while retaining conversations
and file views. Session directories and history survive server restarts;
changing a session's directory does not move Canvas or workspace state files.
Configuration and restoration details are in the [runtime guide](../../docs/RUNTIME.md).

## Feishu

Install the optional SDK in the workspace's Python environment, then authorize:

```bash
python3 -m pip install lark-oapi
python3 -m pycodex_ws.feishu_oauth
```

Authorization reads app credentials from `~/.codex/.env` and stores the refresh
token in `~/.codex/.feishu_refresh_token`. In a workspace session, use
`/link <feishu-email|open_id|chat_id>` to connect a card and `/unlink` to disconnect.
Other workspace features work without the SDK.

## Development

From the repository root:

```bash
uv sync --dev
uv run pycodex-ws --help
uv run --dev pytest packages/pycodex-ws/tests
uv build packages/pycodex-ws
```

Python integrations use `pycodex_ws.build_runtime(agent)` to include workspace
commands. See [runtime contracts](../../docs/RUNTIME.md) and
[test documentation](../../tests/TESTS.md).
