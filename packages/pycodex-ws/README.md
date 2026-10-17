# pycodex-ws

`pycodex-ws` provides the browser workspace, Canvas and file/diff viewer,
and optional Feishu integration for
[`python-codex`](https://pypi.org/project/python-codex/). It installs the exact
matching core version.

Pillow is a direct dependency of this package for image preview validation.
Core can run without it; `view_image` then sends original image bytes.

The HTTP and WebSocket server uses Starlette and Uvicorn, provided by core,
without FastAPI, Pydantic or `pydantic-core`.

```bash
python3 -m pip install pycodex-ws
pycodex-ws --help
```

Requires Python 3.7 or newer. With multiple Python installations, use the
installing interpreter to launch either frontend directly:

```bash
python3 -m workspace_server --help
python3 -m pycodex --help
```

This distribution owns `workspace_server`, `pycodex_ws`, the frontend assets,
and the `pycodex-ws` console script. The core owns `pycodex`, `responses_server`,
the `pycodex` command and portable storage.

The [VS Code extension](extensions/vscode/README.md) lives in this package's
source directory. It starts the workspace server and uses its HTTP API.
It is built and distributed separately as a VSIX, outside both Python wheels
and source distributions.

In the browser's code and diff viewer, right-click **Insert into chat**, or
select text and click the toolbar button, to insert context into the current
conversation's draft. Context uses the full view label, including both revisions
of a diff, and identifies the selected side. It includes either selected text and
its range, or only the cursor position. Context appears as a separate block among the message
text; click a block to edit or remove it before sending.

Workspace sessions include `/link` and `/unlink` for Feishu. Python callers use
`pycodex_ws.build_runtime(agent)` for the same assembly.

The Feishu SDK is optional and is not installed automatically. To enable
`/link`, install it in the same Python environment as the workspace:

```bash
python3 -m pip install lark-oapi
```

`/link` checks that `lark_oapi` can be imported before creating a connection.
If it cannot, the command reports that it is unavailable and shows the manual
installation command. Other workspace features work without the SDK.

For initial Feishu user authorization, run the module included in this package:

```bash
python3 -m pycodex_ws.feishu_oauth
```

It reads app credentials from `~/.codex/.env` and stores the refresh token in
`~/.codex/.feishu_refresh_token` with mode `0600`. `--help` works without
credentials. In a development checkout, use
`uv run --dev python -m pycodex_ws.feishu_oauth`.

Use a filename prefix and a separate Canvas switch in `workspaces.json`:

```json
{
  "workspaces": [
    {"id": "demo", "work_dir": ".", "state_path": "demo", "enable_board": true}
  ]
}
```

Start it with `pycodex-ws --workspace-config workspaces.json`.
Sessions appear in a sidebar on the right. Collapsing it hides the titles and
keeps a clickable column of status dots: running sessions pulse, finished
sessions show a steady green dot, and unread replies retain their red marker.
Hover a dot to see its title, or use the sidebar button to expand the titles.
On narrow screens the expanded sidebar overlays the conversation and returns
to its collapsed state after selecting or creating a session. On phones the
collapsed sidebar is completely hidden; compact, clickable status dots remain
in the chat and board headers instead. Both layouts use
smooth transitions and respect the system's reduced-motion preference.
Session renaming and closing remain available in the expanded sidebar.
Relative paths resolve from the configuration directory. This example uses
`demo.pycodex-ws.json` for session titles, directories and rollout references,
`demo.pycodex-views.json` for file views, and `demo.html` for Canvas.
All suffixes are appended to the complete prefix, including any dots.
The resolved `state_path` identifies the workspace; two entries cannot share it.
Creating a workspace through the management page or API without a prefix
generates a `/tmp/pcws-*` prefix and saves it in the configuration.

Each session starts in `work_dir`. Use `/cd <directory>` while idle to change
only that session, or `/cd` to show its directory. Relative paths and `~` work;
enter paths containing spaces without quotes. A small folder indicator inside
the composer appears only when the directory differs from `work_dir`; hover
for the full path. Directories are restored after server restart, even for empty sessions. Tools,
AGENTS instructions and relative chat/Canvas file links use the selected
session's directory. Existing processes keep their original directory.
Canvas and workspace state files retain their configured locations.

The router directory collects unread workspace shortcuts and their device names
in a distinct Unread panel at the top. Read workspaces leave that panel.
Drag a handle in Online devices to reorder devices; both lists share the saved
order. The focused handle also supports the up and down arrow keys. Escape or
dropping outside the list cancels a drag. On touch screens, drag the handle;
the rest of the card still scrolls normally. List updates wait until the drag
and save finish.
The router saves the order in the existing `CODEX_HOME/router-aliases.json`,
shared by all browsers and retained across router restarts. Its device entry
order is the display order; an empty alias means to show the original name.
Existing alias files remain readable. Offline device positions are
remembered, newly registered devices go last, and each device's workspaces keep
their configuration order. Reordering requires router login; if connected
devices change during a drag, refresh and try again.
Device groups start collapsed, retain their expanded state during updates, and
show Manage and the number of working workspaces in their headings. Click a
device heading or its name to expand or collapse the group. To rename a device,
use its pencil button in the Online devices list, then press Enter or Save;
Escape or Cancel discards the edit. Leaving the field does not save it.
Aliases must be nonblank and contain 1 to 128 characters.
Device headings and the Online devices list share an unread dot
whenever any of that device's workspaces is unread. Final replies and failed
turns both trigger shared unread dots; viewing the reply or error marks it as read.

Login pages state whether you are logging in to the router or workspace service
and show the server hostname and access address.

`enable_board` defaults to `true`. Setting it to `false` disables the Canvas
tab, HTML/image/status routes, polling and Canvas context injection. Sessions
and file views still save and restore from the same prefix, so changing this
switch preserves their state.

Existing `board: "demo.html"` configurations load as `state_path: "demo"`.
Existing `board: false` entries use `<config-stem>.<workspace-id>` as their
prefix, preserving their session index. Loading leaves files in place; later
configuration saves write only `state_path` and `enable_board`.
Do not mix the old and new fields. For an old Canvas path with an extension
other than `.html`, rename it to `<prefix>.html` and set `state_path` explicitly.
Conversation contents remain in their original rollout files.
Malformed session state stops restoration and leaves the saved file intact.

Both packages are developed in the same repository. Run `uv sync --dev` at its
root to install both, then `uv run pycodex-ws --help`. Build this package with
`uv build packages/pycodex-ws`.

Run `uv run --dev pytest packages/pycodex-ws/tests` from the repository root for
workspace, Feishu and cross-frontend integration tests. Core tests live
in the root `tests/` directory and use the independent `test` dependency group.
`uv run --dev pytest` runs both suites; see [test documentation](../../tests/TESTS.md).
