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

The repository's [VS Code extension](../../extensions/vscode/README.md) is also
a workspace frontend: it starts this package's server and uses its HTTP API.
It is built and distributed separately as a VSIX, outside the Python wheel.

Workspace sessions include `/link` and `/unlink` for Feishu. Python callers use
`pycodex_ws.build_runtime(agent)` for the same assembly, or
`from pycodex_ws.ipython import ipython_agent` inside an IPython session.

With `--workspace-config`, a workspace whose `board` is `false` saves its session
index beside that configuration as `<config-stem>.<workspace-id>.pycodex-ws.json`.
Reusing the configuration restores the saved titles and conversation rollouts.
Workspaces with a Canvas continue using the Canvas's `.pycodex-ws.json` sidecar.

Both packages are developed in the same repository. Run `uv sync --dev` at its
root to install both, then `uv run pycodex-ws --help`. Build this package with
`uv build packages/pycodex-ws`.

Run `uv run --dev pytest packages/pycodex-ws/tests` from the repository root for
workspace, Feishu, IPython and cross-frontend integration tests. Core tests live
in the root `tests/` directory and use the independent `test` dependency group.
`uv run --dev pytest` runs both suites; see [test documentation](../../tests/TESTS.md).
