import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

try:
    import tomllib
except ImportError:  # pragma: no cover - exercised on Python < 3.11
    import tomli as tomllib


ROOT = Path(__file__).resolve().parents[1]


def _load_toml(path):
    with path.open("rb") as handle:
        return tomllib.load(handle)


def test_workspace_distribution_tracks_core_version() -> "None":
    core = _load_toml(ROOT / "pyproject.toml")
    workspace = _load_toml(ROOT / "packages" / "pycodex-ws" / "pyproject.toml")
    version = core["project"]["version"]

    assert workspace["project"]["version"] == version
    assert workspace["project"]["dependencies"] == [
        "python-codex=={0}".format(version),
        "lark-oapi",
        "ipython>=7",
        "pillow>=9.0.0",
    ]
    assert not any(
        dependency.startswith(("pillow", "pycryptodomex", "fastapi", "pydantic"))
        for dependency in core["project"]["dependencies"]
    )
    assert core["project"]["scripts"] == {"pycodex": "pycodex.cli:main"}
    assert workspace["project"]["scripts"] == {
        "pycodex-ws": "workspace_server:main",
    }
    assert core["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"] == [
        "pycodex", "responses_server",
    ]
    assert workspace["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"] == [
        "workspace_server", "pycodex_ws",
    ]


def test_runtime_commands_follow_package_boundary():
    from pycodex import Agent, ContextConfig, ToolRegistry
    from pycodex.bootstrap import build_runtime
    from pycodex_ws import build_runtime as build_workspace_runtime
    from tests.fakes import ScriptedModelClient

    core = build_runtime(
        Agent(ScriptedModelClient([]), ToolRegistry(), ContextConfig())
    )
    workspace = build_workspace_runtime(
        Agent(ScriptedModelClient([]), ToolRegistry(), ContextConfig())
    )

    assert "link" not in core.commands()
    assert "unlink" not in core.commands()
    assert set(workspace.commands()) == set(core.commands()) | {"link", "unlink"}


@pytest.mark.parametrize(
    ("arguments", "exit_code", "output"),
    [
        (["--help"], 0, "usage: pycodex "),
        (["doctor", "--help"], 0, "usage: pycodex doctor "),
        (["--unknown-option"], 2, "unrecognized arguments: --unknown-option"),
    ],
)
def test_python_module_entrypoint(tmp_path, arguments, exit_code, output):
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(ROOT)
    result = subprocess.run(
        [sys.executable, "-m", "pycodex"] + arguments,
        cwd=str(tmp_path),
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
        timeout=15,
    )

    assert result.returncode == exit_code, result.stderr
    assert output in result.stdout + result.stderr


@pytest.mark.parametrize("filename", ["test.yml", "publish.yml"])
def test_python36_workflows_install_compatibility_dependencies(filename):
    path = ROOT / ".github" / "workflows" / filename
    workflow = yaml.safe_load(path.read_text(encoding="utf-8"))
    steps = workflow["jobs"]["pytest-py36"]["steps"]
    install = next(
        step
        for step in steps
        if step["name"] == "Install Python 3.6 compatibility dependencies"
    )
    assert '"pyyaml>=6.0"' in install["run"]
    assert '"starlette>=0.19.1,<0.20"' in install["run"]
    assert "fastapi" not in install["run"]


@pytest.mark.skipif(os.name != "posix", reason="CI container uses a POSIX shell")
@pytest.mark.parametrize("filename", ["test.yml", "publish.yml"])
def test_python36_workflows_resolve_sources_inside_container(filename, tmp_path):
    workflow = yaml.safe_load(
        (ROOT / ".github" / "workflows" / filename).read_text(encoding="utf-8")
    )
    step = next(
        item
        for item in workflow["jobs"]["pytest-py36"]["steps"]
        if item["name"] == "Run Python 3.6 pytest"
    )
    environment = dict(os.environ)
    environment["GITHUB_WORKSPACE"] = str(ROOT)
    environment["PYTHONPATH"] = ""
    for name, value in step.get("env", {}).items():
        environment[name] = value.replace(
            "${{ github.workspace }}", str(tmp_path / "host-workspace")
        )
    probe = (
        "import importlib.util, json; "
        "print(json.dumps({name: importlib.util.find_spec(name).origin "
        "for name in ('pycodex', 'responses_server', 'workspace_server', 'pycodex_ws')}))"
    )
    pytest_command = "python -m pytest -c /dev/null"
    assert step["run"].count(pytest_command) == 1
    command = step["run"].replace(
        pytest_command,
        "{} -S -c {}".format(shlex.quote(sys.executable), shlex.quote(probe)),
    )
    result = subprocess.run(
        ["sh", "-eu", "-c", command],
        cwd=str(ROOT),
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
        timeout=15,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "pycodex": str(ROOT / "pycodex" / "__init__.py"),
        "responses_server": str(ROOT / "responses_server" / "__init__.py"),
        "workspace_server": str(
            ROOT / "packages" / "pycodex-ws" / "workspace_server" / "__init__.py"
        ),
        "pycodex_ws": str(
            ROOT / "packages" / "pycodex-ws" / "pycodex_ws" / "__init__.py"
        ),
    }
