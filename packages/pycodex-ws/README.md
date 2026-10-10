# pycodex-ws

`pycodex-ws` is the workspace-oriented installation name for
[`python-codex`](https://pypi.org/project/python-codex/).

```bash
python3 -m pip install pycodex-ws
pycodex-ws --help
```

Requires Python 3.6.2 or newer. With multiple Python installations, use the
installing interpreter to launch either frontend directly:

```bash
python3 -m workspace_server --help
python3 -m pycodex --help
```

This distribution intentionally contains only package metadata. It depends on
the exact matching `python-codex` version, which provides the `workspace_server`
implementation and the `pycodex-ws` console script.
