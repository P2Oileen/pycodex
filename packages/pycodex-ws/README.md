# pycodex-ws

`pycodex-ws` provides the browser workspace, Canvas and file/diff viewer,
Feishu integration and IPython tools for
[`python-codex`](https://pypi.org/project/python-codex/). It installs the exact
matching core version and all integration dependencies.

Pillow is a direct dependency of this package for image preview validation.
Core can run without it; `view_image` then sends original image bytes.

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

Workspace sessions include `/link` and `/unlink` for Feishu. Python callers use
`pycodex_ws.build_runtime(agent)` for the same assembly, or
`from pycodex_ws.ipython import ipython_agent` inside an IPython session.

Both packages are developed in the same repository. Run `uv sync --dev` at its
root to install both, then `uv run pycodex-ws --help`. Build this package with
`uv build packages/pycodex-ws`.
