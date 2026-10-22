# 0.5.1 release notes

These notes compare **0.5.1 with the tagged 0.5.0 release**. This release
improves Responses reliability and diagnostics, workspace input history,
Markdown viewing and slash-prefixed input.

## Responses reliability and diagnostics

- HTTP 408, 429 and server errors use the provider's retry budget. Rate-limit
  messages containing `try again in` or `retry after` supply the retry delay,
  including values expressed in milliseconds.
- CLI, workspace and Feishu retry notices include the underlying error.
  Workspace notices remain separate from the assistant reply and survive
  browser refresh and active-turn reattachment. They are not saved in rollouts.
- Optional `stream_first_data_timeout_ms` bounds the initial wait for response
  body data, including headers. After the first bytes arrive,
  `stream_idle_timeout_ms` applies. Omitting the new option preserves the
  existing timeout behavior; neither setting is a total generation deadline.
- Each HTTP attempt emits `model_request_timing` with the model, elapsed time,
  time to first data and outcome. Compaction requests also expose these events.
  Without the first-data timeout option, first-data timing uses the first
  streamed line.
- Optional provider `fallback_models` enables ordered retries with backup
  models on the same endpoint. Transient errors exhaust the current model's
  retry budget before switching; unavailable-model errors and first-data
  timeouts switch immediately when another target is available. Notices name
  both models and retain the failed attempt's diagnostic.
- Failed models cool down within that client for 900 seconds by default.
  `fallback_cooldown_seconds = 0` disables cooldown. Explicit model selection
  clears it, and new sessions and subagents have independent cooldown state.
  When every target is cooling, the next request tries the full chain again.

Failover is disabled unless configured. It preserves the selected primary,
history and tools while rebuilding request settings for each target. Invalid
input, context-length and terminal incomplete errors retain their existing
handling. Backups must support the active tools and context size; compaction
continues to use the selected model's policy. Configure these options in the
provider's existing `[model_providers.<name>]` table.

## Workspace input and Markdown views

- Up/Down in the message box recalls human inputs in the current conversation
  and returns to the unsent draft. Automatic wake-up messages are excluded,
  and arrows retain normal cursor movement inside multiline drafts.
- Markdown file views have a Show source / Show preview button. Switching
  modes preserves each mode's reading position without replaying an old
  line target.

## Slash input

- Paths such as `/data/project` and `/tmp/` are ordinary messages. Unknown
  single-component names such as `/modle` or `/tmp` still report a command
  error.
- A leading ASCII space sends slash-prefixed input literally, including known
  commands such as ` /model`. CLI, workspace and Feishu use the same rules.

## Upgrade

For a workspace installation, upgrading the extension installs the matching core:

```bash
python3 -m pip install --upgrade pycodex-ws==0.5.1
```

For a core-only installation:

```bash
python3 -m pip install --upgrade python-codex==0.5.1
```

Python support remains 3.6.2+ for core and 3.7+ for workspace. The workspace
package requires exactly `python-codex==0.5.1`; the VS Code extension remains
separately distributed. See [runtime documentation](RUNTIME.md) for the
configuration and event contracts.
