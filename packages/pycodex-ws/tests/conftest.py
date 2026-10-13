"""Keep workspace integrations away from the developer's home directory."""

import pytest


@pytest.fixture(autouse=True)
def isolate_workspace_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "home" / ".codex"))
