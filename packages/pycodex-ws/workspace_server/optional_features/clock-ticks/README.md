---
title: "Clock tick dividers"
summary: "Show periodic wake-ups as quiet timestamped dividers in the conversation."
tags: [clock, conversation]
---

# Clock tick dividers

## Behavior

A complete `<clock_tick>` prompt with a positive numeric `period_m` and a
timezone-aware ISO `current_time` becomes a thin divider with a small clock,
“定时唤醒” and the trigger time. Click or keyboard-activate it to see the full
timestamp and delay after the previous reply. The compact time uses the browser's
timezone; details retain the recorded timestamp and UTC offset.

Ordinary prompts, quoted examples, malformed notifications and other background
events keep their original rendering. Replies, errors and tool records stay
visible. Existing historical ticks and incoming ticks use the same presentation.
This is presentation only; it does not change timers, prompts or saved history.

## Source

- [source/custom.js](source/custom.js): parses complete clock prompts and attaches
  a native expandable divider alongside the original prompt element.
- [source/custom.css](source/custom.css): divider, focus and mobile styles using
  the page's existing theme variables.

## Integration

Copy this directory into `~/.pycodex/frontend/optional_features/clock-ticks/`.
Append this side-effect import to the existing `~/.pycodex/frontend/custom.js`,
preserving its existing imports and exports:

```js
import "./optional_features/clock-ticks/source/custom.js";
```

Append this import to `~/.pycodex/frontend/custom.css` (before any ordinary rules):

```css
@import "./optional_features/clock-ticks/source/custom.css";
```

Refresh the workspace. No build step, external dependency or server restart is
needed. The module observes `#log` and direct `.entry.user > .text` prompt
elements. It preserves their class names, source text and renderer-owned nodes.
It adds a `data-clock-tick` attribute and its own `<details>` sibling; CSS hides
the source only on successfully parsed notifications.

The script initializes after DOM readiness, decorates already-loaded history,
and watches prompt additions/changes. Repeated mounting is idempotent;
`installClockTicks(log)` returns a cleanup function that disconnects observation,
removes the presentation and reveals the untouched source. Session changes
remove entries through the host's normal renderer.

Remove the two imports and refresh to undo. `?builtin=1` also bypasses all user
customizations.

## Validation

Browser checks cover history loaded before/after initialization, newly arriving
ticks, stable details while responses stream, ordinary/malformed/quoted prompts,
source updates, session replacement, cleanup, keyboard interaction, and narrow
screens. Validation evidence is maintained alongside the local integration.

## Preview

```text
────────── ◷ 定时唤醒 · 14:40 ──────────
```

The closed divider occupies one quiet row. Opening it reveals two detail rows.

## Limitations

Labels currently use Chinese. This source assumes the documented conversation
DOM and requires adaptation if a full custom template replaces it. A user prompt
that exactly reproduces a valid clock envelope is visually indistinguishable
from a generated tick in that DOM. This implementation does not add timer
controls, countdowns, animation or grouping of repeated checks.
