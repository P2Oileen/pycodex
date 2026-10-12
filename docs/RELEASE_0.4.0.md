# 0.4.0 release notes

Version **0.4.0** separates the core and workspace distributions and reduces
runtime dependencies. Both packages use the same version; `pycodex-ws` depends
on exactly `python-codex==0.4.0`. Both PyPI and TestPyPI publish `python-codex`
first, then `pycodex-ws` after the core upload succeeds.

## Core and workspace packages

| Package | Contents | Python |
| --- | --- | --- |
| `python-codex` | Agent, runtime, CLI, standard tools, Responses compatibility server and all portable storage functionality | 3.6.2+ |
| `pycodex-ws` | Browser workspace, viewer assets, Feishu and IPython integrations | 3.7+ |

`pycodex-ws` now owns its code and resources, including `workspace_server`,
`pycodex_ws` and the `pycodex-ws` command. The core package owns `pycodex`,
`responses_server` and the `pycodex` command. Install the workspace package to
upgrade both packages together and include the integration dependencies.

Python integrations use `pycodex_ws.build_runtime()` for workspace assembly
and `from pycodex_ws.ipython import ipython_agent` for IPython. Feishu adapters
also live under `pycodex_ws`. Core callers continue to use
`pycodex.bootstrap.build_runtime()`.

The Feishu authorization helper is included in the workspace wheel and source
distribution. Run `python3 -m pycodex_ws.feishu_oauth` after installation;
the old repository-only `tools/feishu_oauth.py` path is removed.

## Smaller runtime dependencies

- Core no longer requires Pillow. When Pillow is absent, `view_image` returns
  the original image with `detail="original"`, including when `high` is
  requested. With Pillow installed, the default path still resizes images to
  a maximum dimension of 2048. The workspace package installs Pillow directly.
- Portable AES-256-GCM uses bundled pure Python code from pyaes and tlslite-ng,
  with MIT/BSD notices. Core requires no crypto extension or compiler. Existing
  `PCX1` bundles and call tokens remain compatible; large bundles take longer
  to encrypt and decrypt.
- The Responses and workspace HTTP services use Starlette and Uvicorn
  directly. Neither package requires FastAPI, Pydantic or `pydantic-core`.
  Both project wheels are universal `py3-none-any` wheels.

Workspace JSON endpoints return HTTP 422 with a `detail` message for invalid
bodies or content types. They no longer return Pydantic's structured validation
errors. Automatic `/docs`, `/redoc` and `/openapi.json` endpoints are removed.
Authentication, WebSocket sessions, SSE streaming and runtime shutdown keep
their existing behavior.

## Internal module paths

The `pycodex/` top level now contains eight core modules and two package entry
points. Supporting modules moved as follows:

| Previous import | New import |
| --- | --- |
| `pycodex.runtime_services` | `pycodex.tools.runtime_services` |
| `pycodex.compat` | `pycodex.utils.compat` |
| `pycodex.doctor` | `pycodex.utils.doctor` |
| `pycodex.model_metadata` | `pycodex.utils.model_metadata` |
| `pycodex.portable_server` | `pycodex.portable.server` |

Public client functions remain available from `pycodex.portable`; their
implementation and private helpers live in `pycodex.portable.client`.
Import `compact`, `DEFAULT_COMPACT_PROMPT` and `SUMMARY_PREFIX` directly from
`pycodex.utils.compactor`. The old top-level modules and the compactor
re-exports from `pycodex.utils` are removed.

Root APIs such as `from pycodex import Agent` and `pycodex.debug()` remain
available. The packaging and directory changes preserve tool descriptions,
schemas and prompt resources. See [package layout](RUNTIME.md#package-layout).

## Reply and status display

CLI and Web use `understood` for the initial turn status. Feishu cards keep
streaming replies separate from command results, questions and errors, and clear
the failed attempt's streaming text when a model request retries.

## Workspace state and Canvas

Workspace configuration uses a `state_path` filename prefix and `enable_board`
(default `true`). For `state_path: "demo"`, sessions use `demo.pycodex-ws.json`,
file views use `demo.pycodex-views.json`, and Canvas uses `demo.html`. Suffixes
are appended even when the prefix contains dots. The resolved prefix identifies
the workspace independently of Canvas.

Disabling Canvas removes its tab, routes, polling and context injection while
preserving session and file-view persistence. Existing `board: "demo.html"` and
`board: false` configurations normalize to the new fields at load time and keep
their original state files and rollout references. Subsequent config saves use
only the new format; mixed fields and non-`.html` legacy paths are rejected.

The VS Code extension now keeps one private configuration per project and
restores saved conversations on reopening the sidebar. It requires backend
0.4.0 and creates workspaces with Canvas disabled. Browser code/diff views can
insert selected text, or just the file/cursor location, into the chat draft.

## Upgrade

For the CLI and core API:

```bash
python3 -m pip install --upgrade python-codex==0.4.0
python3 -m pycodex --help
```

For an existing Web installation or the integration SDKs:

```bash
python3 -m pip install --upgrade pycodex-ws==0.4.0
python3 -m workspace_server --help
```

The portable client keeps `pycodex --put` and `pycodex --call`. Start its
storage server with the new module path:

```bash
python3 -m pycodex.portable.server --root .tmp/pycodex_storage --host 127.0.0.1 --port 5577
```
