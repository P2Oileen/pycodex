# Changelog

## 0.0.4

Requires `pycodex-ws>=0.4.0`.

- Insert only file and cursor information when no code is selected.
- Keep selected text and explicit Explorer/SCM file excerpts; omit code around
  the cursor.
- Omit the language field and show either the selection range or the cursor
  position in each context block.
- Share the text/token composer with the browser workspace.
- Limit context tokens to 180px with an ellipsis and the full label on hover.

## 0.0.3

Requires `pycodex-ws>=0.4.0` for session persistence without a Canvas.

- Follow the VS Code theme for sidebar, input, text and border colors.
- Keep one workspace configuration per project in the extension's private
  storage on the workspace host.
- Restore conversations with history when reopening the sidebar after a restart.
  Empty sessions stay out of the restored list.

## 0.0.2

Requires `pycodex-ws>=0.3.1` and Python 3.7 or newer on the workspace host.

- Show intermediate assistant text directly, without collapsible sections or
  per-turn status labels.
- Display backend status text without translation.
- Install and check `pycodex-ws`, which supplies the workspace backend and its
  matching `python-codex` version.

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
