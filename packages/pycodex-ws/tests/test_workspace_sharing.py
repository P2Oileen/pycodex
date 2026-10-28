import asyncio
import json
import threading

import pytest
from starlette.testclient import TestClient
from starlette.applications import Starlette
from starlette.routing import Mount
from starlette.websockets import WebSocketDisconnect

from workspace_server import (
    WorkspaceDefinition, WorkspaceEntry, WorkspaceRegistry, WorkspaceSessionManager,
    create_app, create_multi_workspace_app,
)
from pycodex import AssistantMessage, ModelResponse
from tests.fakes import ScriptedModelClient
from test_workspace_server import make_session, wait_snapshot


@pytest.fixture(params=[False, True], ids=["single", "multi"])
def sharing_setup(request, tmp_path):
    multi = request.param

    def create(password="admin-password"):
        def entry(name):
            state = tmp_path / name
            state.with_suffix(".html").write_text("<html>shared canvas</html>", encoding="utf-8")
            return WorkspaceEntry(
                WorkspaceDefinition(name, state, tmp_path),
                WorkspaceSessionManager(lambda: make_session(cwd=tmp_path), state),
            )

        if multi:
            registry = WorkspaceRegistry(
                [entry("first"), entry("other")],
                config_path=tmp_path / "workspaces.json",
            )
            registry.persist_definitions()
            return create_multi_workspace_app(registry, password)
        first = entry("workspace")
        return create_app(first.manager, first.definition.state_path, password, tmp_path)

    return create, "/w/first" if multi else ""


def enable_share(browser, prefix):
    assert browser.post("/login", json={"password": "admin-password"}).status_code == 200
    admin_cookie = browser.cookies["pycodex_ws_auth"]
    response = browser.put(prefix + "/api/share", json={"password": "visitor-password"})
    assert response.status_code == 200
    assert response.json()["enabled"]
    assert set(response.json()) == {"enabled", "available", "url"}
    browser.cookies.clear()
    return {"cookie": "pycodex_ws_auth=" + admin_cookie}


def visitor_login(browser, prefix, password="visitor-password"):
    return browser.post("/login", params={"next": prefix + "/"}, json={"password": password})


def test_share_login_is_scoped_and_keeps_workspace_operations(sharing_setup):
    create, prefix = sharing_setup
    with TestClient(create()) as browser:
        admin = enable_share(browser, prefix)
        response = browser.get(prefix + "/", follow_redirects=False)
        assert response.status_code == 303
        assert response.headers["location"].startswith("/login?")
        assert visitor_login(browser, prefix, "wrong").status_code == 401
        response = visitor_login(browser, prefix)
        assert response.json() == {"ok": True, "redirect": prefix + "/"}
        assert "HttpOnly" in response.headers["set-cookie"]
        page = browser.get(prefix + "/")
        assert page.status_code == 200
        assert 'data-access-role="visitor"' in page.text
        for path in ("/board", "/assets/content_views.mjs", "/api/sessions", "/api/session"):
            assert browser.get(prefix + path).status_code == 200
        assert browser.post(
            prefix + "/api/sessions", json={"title": "Shared session", "prompt": "Hello"},
        ).status_code == 200
        for method in ("GET", "PUT", "DELETE"):
            assert browser.request(
                method, prefix + "/api/share", json={"password": "changed"},
            ).status_code == 403
            assert browser.request(
                method, prefix + "/api/share/", json={"password": "changed"},
            ).status_code == 403
        if prefix:
            foreign_session = browser.get("/w/other/api/session", headers=admin).json()["session_id"]
            assert browser.get(
                prefix + "/api/session", params={"session_id": foreign_session},
            ).status_code == 404
            for path in ("/", "/api/workspaces", "/w/other/", "/w/other/api/session"):
                assert browser.get(path, follow_redirects=False).status_code in (401, 303)
            with pytest.raises(WebSocketDisconnect):
                with browser.websocket_connect("/w/other/ws/session"):
                    pass
        # Exercise disconnects racing with the connection's revocation waiter.
        for _ in range(100):
            with browser.websocket_connect(prefix + "/ws/session") as connection:
                assert connection.receive_json()["type"] == "hello"
                connection.send_json({"type": "ping"})
                assert connection.receive_json() == {"type": "pong"}
        assert browser.post(
            "/login?next=" + prefix + "/", json={"password": "admin-password"},
        ).status_code == 200
        assert 'data-access-role="admin"' in browser.get(prefix + "/").text
        assert browser.get(prefix + "/api/share").status_code == 200


@pytest.mark.parametrize("operation", ["rotate", "disable"])
def test_share_revocation_disconnects_open_websockets(sharing_setup, operation):
    create, prefix = sharing_setup
    with TestClient(create()) as browser:
        admin = enable_share(browser, prefix)
        assert visitor_login(browser, prefix).status_code == 200
        with browser.websocket_connect(prefix + "/ws/session") as connection:
            assert connection.receive_json()["type"] == "hello"
            if operation == "rotate":
                result = browser.put(prefix + "/api/share", headers=admin, json={"password": "新的密码"})
            else:
                result = browser.delete(prefix + "/api/share", headers=admin)
            assert result.status_code == 200
            with pytest.raises(WebSocketDisconnect) as closed:
                connection.receive_json()
            assert closed.value.code == 1008
        assert browser.get(prefix + "/api/session").status_code == 401
        assert visitor_login(browser, prefix).status_code == 401
        if operation == "rotate":
            assert visitor_login(browser, prefix, "新的密码").status_code == 200
            assert browser.get(prefix + "/api/session").status_code == 200
        assert browser.get(prefix + "/api/share", headers=admin).status_code == 200


def test_share_passwords_are_not_persisted(sharing_setup, tmp_path):
    create, prefix = sharing_setup
    with TestClient(create()) as browser:
        enable_share(browser, prefix)
        visitor_login(browser, prefix)
        cookie = browser.cookies["pycodex_ws_auth"]
    for path in tmp_path.glob("*.json"):
        assert "visitor-password" not in path.read_text(encoding="utf-8")
        if path.name == "workspaces.json":
            assert all(set(item) == {"id", "state_path", "work_dir", "enable_board"}
                       for item in json.loads(path.read_text())["workspaces"])
    with TestClient(create()) as restarted:
        assert restarted.get(
            prefix + "/api/session", headers={"cookie": "pycodex_ws_auth=" + cookie},
        ).status_code == 401
        assert visitor_login(restarted, prefix).status_code == 401


def test_share_password_validation_and_unprotected_server(sharing_setup):
    create, prefix = sharing_setup
    with TestClient(create()) as browser:
        browser.post("/login", json={"password": "admin-password"})
        for password in ("", None, 12, "admin-password"):
            assert browser.put(prefix + "/api/share", json={"password": password}).status_code == 422
        assert not browser.get(prefix + "/api/share").json()["enabled"]
    with TestClient(create(password=None)) as browser:
        assert not browser.get(prefix + "/api/share").json()["available"]
        assert browser.put(prefix + "/api/share", json={"password": "visitor-password"}).status_code == 400
        assert browser.get(prefix + "/api/session").status_code == 200


def test_share_login_cannot_choose_a_different_workspace(sharing_setup):
    create, prefix = sharing_setup
    with TestClient(create()) as browser:
        enable_share(browser, prefix)
        if prefix:
            assert visitor_login(browser, "/w/other").status_code == 401
            assert browser.post("/login", json={"password": "visitor-password"}).status_code == 401
        assert visitor_login(browser, prefix).status_code == 200
        browser.cookies.set("pycodex_ws_auth", "tampered", domain="testserver.local", path="/")
        assert browser.get(prefix + "/api/session").status_code == 401


def test_sharing_preserves_a_mounted_path_prefix(sharing_setup):
    create, prefix = sharing_setup
    workspace = create()
    app = Starlette(
        routes=[Mount("/device", workspace)],
        lifespan=workspace.router.lifespan_context,
    )
    with TestClient(app) as browser:
        assert browser.post("/device/login", json={"password": "admin-password"}).status_code == 200
        response = browser.put("/device" + prefix + "/api/share", json={"password": "visitor-password"})
        assert response.json()["url"] == "/device" + prefix + "/"
        browser.cookies.clear()
        response = browser.post(
            "/device/login", params={"next": "/device" + prefix + "/"},
            json={"password": "visitor-password"},
        )
        assert response.json()["redirect"] == "/device" + prefix + "/"
        assert "Path=/device/" in response.headers["set-cookie"]
        assert browser.get("/device" + prefix + "/api/session").status_code == 200
        assert browser.get("/device" + prefix + "/api/share").status_code == 403
        with browser.websocket_connect("/device" + prefix + "/ws/session") as connection:
            assert connection.receive_json()["type"] == "hello"


def test_revoking_access_does_not_cancel_accepted_agent_work(tmp_path):
    started = threading.Event()
    finish = threading.Event()

    async def reply(prompt, count):
        started.set()
        while not finish.is_set():
            await asyncio.sleep(0.01)
        return ModelResponse([AssistantMessage("finished after revocation")])

    model = ScriptedModelClient(response_factory=reply)
    app = create_app(lambda: make_session(model=model, cwd=tmp_path), None, password="admin-password")
    with TestClient(app) as browser:
        admin = enable_share(browser, "")
        assert visitor_login(browser, "").status_code == 200
        try:
            with browser.websocket_connect("/ws/session") as connection:
                assert connection.receive_json()["type"] == "hello"
                connection.send_json({"type": "send", "prompt": "Keep working"})
                assert started.wait(3)
                assert browser.delete("/api/share", headers=admin).status_code == 200
                with pytest.raises(WebSocketDisconnect) as closed:
                    while True:
                        connection.receive_json()
                assert closed.value.code == 1008
        finally:
            finish.set()
        browser.post("/login", json={"password": "admin-password"})
        snapshot = wait_snapshot(browser, lambda state: state["turns"] and state["turns"][-1]["status"] == "completed")
        assert snapshot["turns"][-1]["response"] == "finished after revocation"
