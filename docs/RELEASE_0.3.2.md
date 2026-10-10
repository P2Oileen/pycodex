# 0.3.2 release notes

Both `python-codex` and `pycodex-ws` use version **0.3.2**. The workspace
metapackage depends on exactly `python-codex==0.3.2`; publish the core package
first.

## Startup fixes

- Codex configurations may omit `model_provider`. In that case, use the built-in
  `openai` provider without requiring a `[model_providers.openai]` table.
  Its default API address is `https://api.openai.com/v1`, with
  `openai_base_url` available as an override and `OPENAI_API_KEY` supplying
  authentication. Existing explicit provider tables keep their behavior;
  unknown provider names produce a descriptive configuration error.
- Add `python3 -m pycodex` so installation and startup can explicitly use the
  same interpreter on hosts with multiple Python installations.
  The browser frontend remains available through
  `python3 -m workspace_server` or the `pycodex-ws` command.
- Check installed wheel entry points in a fresh environment before publication,
  covering both console scripts and both module entry points outside the source
  checkout. Add provider-selection and module-exit-status regressions.

The configuration still needs `model`, either at the top level or in the
selected profile. Authentication uses environment API keys or `.env`;
stored ChatGPT sign-in credentials from the official Codex CLI/desktop app
are not loaded.

## Upgrade

```bash
python3 -m pip install --upgrade pycodex-ws==0.3.2
python3 -m pycodex
python3 -m workspace_server --help
```

`python3 -m pycodex-ws` is not a module entry point.
