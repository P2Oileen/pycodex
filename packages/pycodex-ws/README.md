# pycodex-ws

`pycodex-ws` provides the browser workspace, Canvas and file/diff viewer,
Feishu integration and IPython tools for
[`python-codex`](https://pypi.org/project/python-codex/). It installs the exact
matching core version and all integration dependencies.

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
`pycodex_ws.build_runtime(agent)` for the same assembly, or
`from pycodex_ws.ipython import ipython_agent` inside an IPython session.

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
Relative paths resolve from the configuration directory. This example uses
`demo.pycodex-ws.json` for session titles and rollout references,
`demo.pycodex-views.json` for file views, and `demo.html` for Canvas.
All suffixes are appended to the complete prefix, including any dots.
The resolved `state_path` identifies the workspace; two entries cannot share it.
Creating a workspace through the management page or API without a prefix
generates a `/tmp/pcws-*` prefix and saves it in the configuration.

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
workspace, Feishu, IPython and cross-frontend integration tests. Core tests live
in the root `tests/` directory and use the independent `test` dependency group.
`uv run --dev pytest` runs both suites; see [test documentation](../../tests/TESTS.md).
