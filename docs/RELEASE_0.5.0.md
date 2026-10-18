# 0.5.0 release notes

Version **0.5.0** adds user-owned workspace frontends. `python-codex` and
`pycodex-ws` share this version; `pycodex-ws` requires exactly
`python-codex==0.5.0`. Publish core first, then workspace.

## Customize the workspace interface

- Put an optional `workspace.html`, `custom.css` or `custom.js` in the server
  user's `~/.pycodex/frontend/`. Supporting assets can live in the same
  directory. This location is independent of `CODEX_HOME`.
- Refresh to apply edits. Open the workspace with `?builtin=1` to temporarily
  bypass all customizations; the recovery page links back to the custom UI.
- The settings button opens a customization conversation. Its title, prompt,
  development guidance and browser language preferences are assembled in the
  editable frontend.
- The existing session creation API accepts optional `title` and `prompt`
  strings. Empty requests continue to create ordinary empty sessions.
- Custom CSS keeps its precedence when the code editor loads lazily.

## Workspace usability

- Refined desktop and phone session sidebar behavior and controls.
- Refresh and recovery navigation retain the current session independently
  for each browser tab.
- Customization scope, refresh instructions and recovery links remain visible
  outside the folded setup context.

Python support remains 3.6.2+ for core and 3.7+ for workspace. The Feishu SDK
remains optional. See [runtime documentation](RUNTIME.md#frontend-customization)
for the frontend file and API contracts.
