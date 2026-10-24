# Optional frontend features

Browse this catalog in the workspace view area, then tell the customization
Agent which features to apply by name or ID. For example: "Show me the available
features" or "Apply the exec status feature using my current layout."
The Agent reads the selected source and adapts it into your frontend.

The supplied panels stay hidden until they have matching content, and hide again
when that content disappears. Unselected sessions and initial loading occupy no
space. Request failures remain visible; reasoning records need readable text.

| ID | Feature | Summary | Validation |
| --- | --- | --- | --- |
| exec-status | [Exec status](exec-status/README.md) | Running and exited command sessions above the composer. | Chromium fixtures, lifecycle, desktop/mobile; live processes not tested |
| reasoning-display | [Recorded reasoning](reasoning-display/README.md) | Readable recorded reasoning summaries and text. | Chromium fixtures, opaque filtering, desktop/mobile; live model not tested |
| subagent-status | [Subagent status](subagent-status/README.md) | Descendant agents, parents and completion/error details. | Chromium fixtures, lifecycle, desktop/mobile; live agents not tested |
| tool-calls | [Tool calls](tool-calls/README.md) | Recent function/custom calls with paired inputs and results. | Chromium fixtures, lifecycle, desktop/mobile; live tools not tested |

Each published row links its feature name to `<feature-id>/README.md`.
Only list features whose source and documentation are present in this library;
proposals and open PRs are not available features.

To contribute, tell the Agent: "Publish my local change as a feature PR."
The [contribution guide](CONTRIBUTING.md) defines the source layout, README and
format for pull requests on GitHub.
