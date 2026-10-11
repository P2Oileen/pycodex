# 0.3.3 release notes

Both `python-codex` and `pycodex-ws` use version **0.3.3**. The workspace
metapackage depends on exactly `python-codex==0.3.3`; publish the core package
first.

## Workspace file and diff viewers

- Open file, Git revision, and diff links from replies or Canvas in persistent
  board tabs. Source and diff views use read-only Monaco editors with line
  navigation and syntax highlighting.
- Preview Markdown, HTML, and images directly. Add a line number to a Markdown
  or HTML link to open its source; click the link without a line number to return
  to the preview in the same tab. `workspace://canvas` returns to Canvas.
- Local files refresh as they change, while Git views retain their resolved
  revision. Each browser page keeps its own active tab, preview mode, and reading
  position. Opening a view does not submit a message to the agent.
- Load the editor only when opening source or a diff. The wheel includes editor
  assets, fonts, and the diff worker, so installed workspaces do not need Node.
  Static assets support cached gzip responses and conditional requests.

## Reasoning stream fix

Chat-completions compatibility mode now forwards `reasoning` and
`reasoning_content` increments immediately as `response.reasoning_text.delta`
events. Long reasoning phases continue to send data to the client, avoiding
stream idle timeouts while the backend is still generating.

Repeated reasoning aliases are deduplicated. Final reasoning items and the
existing retry behavior for responses containing only reasoning are preserved.
Regression coverage includes a client request whose reasoning phase lasts
longer than its configured stream idle timeout.

## Upgrade

```bash
python3 -m pip install --upgrade pycodex-ws==0.3.3
python3 -m pycodex
python3 -m workspace_server --help
```

Installing `pycodex-ws==0.3.3` also installs `python-codex==0.3.3`. The import
path and both console commands remain unchanged.
