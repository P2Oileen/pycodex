# Changelog

## 0.0.1

Initial release. Requires `python-codex>=0.3.1` on the workspace host.

- Add sidebar chat with independent sessions, Markdown replies and saved drafts.
- Run the Python backend on the workspace host, including Remote SSH, WSL and
  Dev Containers, and reuse or upgrade the selected Python installation.
- Select a project venv or another Python interpreter and edit the Codex Profile
  from the chat settings menu.
- Support Codex profiles, editable code context inserted into messages, and
  context usage details.
- Let accepted tasks finish when closing sessions or the workspace.
- Show concise startup errors with expandable diagnostics, retry and settings
  actions.
