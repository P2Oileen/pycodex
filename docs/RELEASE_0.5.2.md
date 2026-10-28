# 0.5.2 release notes

These notes compare **0.5.2 with the tagged 0.5.1 release**. This release adds
workspace sharing, session profiles, native PDF previews and a documented API
for custom frontends, along with interface improvements and optional features.

## Workspace sharing and session profiles

- **Settings → Share** creates a separate password for visitors to the current
  workspace. Visitors can use its sessions and views, while management controls
  remain administrator-only. Changing the password or stopping sharing revokes
  existing access. Sharing is held in memory and ends on server restart.
- Shared WebSocket connections clean up their revocation watchers on disconnect
  without leaking cancellation errors into the connection owner.
- **New session** creates a session using the launch profile. Its **+** button
  lets you select another named profile from the server's Codex configuration.
  The selected profile configures both the model and Agent instructions.
- Each tab saves its profile and restores it after a restart, even if the launch
  default changes. Older saved tabs use the current launch default. Removing a
  saved profile from the configuration reports an error during restoration.

## Views and interface

- Local PDF links open in the browser's built-in reader, with separate
  **Open in new tab** and **Download** links. Authenticated file responses stream
  the PDF without storing its bytes in view snapshots or applying the text/image
  2 MiB limit. File changes refresh the preview; unchanged files keep the reader.
  This supports local PDFs, not Git PDF snapshots or PDF comparisons.
- Settings uses descriptive **Customize Agent** and **Share** entries, updated
  icons and consistent dialogs on desktop and narrow screens. Customize Agent
  starts the existing conversation for changing the workspace interface.
- While an Agent is working, the empty composer rotates short usage hints.
  Drafts and input composition remain intact, and hints pause while waiting
  for an answer.
- Consecutive model reconnection diagnostics collapse into a summary that can
  be expanded to inspect individual attempts.

## Custom frontends and optional features

- The workspace API exposes Runtime state, model catalogs, asynchronous command
  receipts and results, paginated history, descendant Agents, background work
  and cursored WebSocket replay. The built-in page also supplies a versioned
  session, draft and view interface to custom frontend modules.
- The packaged feature catalog includes command status, descendant Agent status,
  paired tool calls and results, readable recorded reasoning, consecutive tool
  groups and browser-local per-conversation notes. These are optional sources
  for the customization Agent to adapt into the user's interface.
- Optional panels stay hidden while loading or when there is no matching
  content. Errors remain visible. Recorded reasoning requires readable stored
  text and does not imply access to live hidden reasoning.

## Upgrade

For a workspace installation, upgrading the extension installs the matching core:

```bash
python3 -m pip install --upgrade pycodex-ws==0.5.2
```

For a core-only installation:

```bash
python3 -m pip install --upgrade python-codex==0.5.2
```

Restart the workspace service after upgrading, then refresh the browser.
Python support remains 3.6.2+ for core and 3.7+ for workspace. The workspace
package requires exactly `python-codex==0.5.2`; the VS Code extension remains
separately distributed. See the [runtime documentation](RUNTIME.md) and
[workspace API reference](../packages/pycodex-ws/workspace_server/WORKSPACE_API.md)
for the full contracts.
