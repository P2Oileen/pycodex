# Optional frontend features

Browse this catalog in the workspace view area, then tell the customization
Agent which features to apply by name or ID. For example: "Show me the available
features" or "Apply the exec status feature using my current layout."
The Agent reads the selected source and adapts it into your frontend.

| ID | Feature | Summary | Validation |
| --- | --- | --- | --- |
| exec-status | [Exec status](exec-status/README.md) | Running and exited command sessions above the composer. | Chromium fixtures, lifecycle, desktop/mobile; live processes not tested |

Each published row links its feature name to `<feature-id>/README.md`.
Only list features whose source and documentation are present in this library;
proposals and open PRs are not available features.

To contribute, tell the Agent: "Publish my local change as a feature PR."
The [contribution guide](CONTRIBUTING.md) defines the source layout, README and
format for pull requests on GitHub.
