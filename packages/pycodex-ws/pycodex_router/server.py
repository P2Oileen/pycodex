import argparse
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from starlette.applications import Starlette
from starlette.requests import HTTPConnection
from starlette.responses import HTMLResponse, JSONResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.websockets import WebSocketDisconnect, WebSocketState
from workspace_server.app import _auth_cookie_matches, _install_auth, parse_listen
from workspace_server.workspaces import normalize_workspace_id

from .browser import BrowserOrigins, device_url, redirect_device, require_login
from .protocol import (
    decode,
    device_id,
    encode,
    request_scope,
    response_headers,
    send_event,
)


class TunnelUnavailable(Exception):
    pass


class Node:
    def __init__(self, websocket, node_id, name, workspaces):
        self.websocket = websocket
        self.id = node_id
        self.name = name
        self.workspaces = workspaces
        self.streams = {}
        self.send_lock = asyncio.Lock()


class Stream:
    def __init__(self, node_id):
        self.node_id = node_id
        self.ready = asyncio.get_running_loop().create_future()
        self.done = asyncio.Event()
        self.websocket = None


async def close_websocket(websocket, code=1000):
    if websocket.application_state == WebSocketState.CONNECTED:
        try:
            await websocket.close(code=code)
        except (WebSocketDisconnect, OSError):
            pass


async def control_message(websocket):
    payload = await websocket.receive_text()
    if not isinstance(payload, str) or len(payload.encode("utf-8")) > 1024 * 1024:
        raise ValueError("router control messages must not exceed 1 MiB")
    return decode(payload)


def validate_inventory(workspaces):
    if not isinstance(workspaces, list) or len(workspaces) > 256:
        raise ValueError("workspace inventory must be a list of at most 256 entries")
    fields = {
        "id",
        "work_dir",
        "state_path",
        "enable_board",
        "session_count",
        "running",
    }
    seen = set()
    for workspace in workspaces:
        if not isinstance(workspace, dict) or set(workspace) != fields:
            raise ValueError("invalid workspace inventory fields")
        workspace_id = workspace["id"]
        if (
            not isinstance(workspace_id, str)
            or not workspace_id
            or len(workspace_id) > 128
            or normalize_workspace_id(workspace_id) != workspace_id
            or workspace_id in seen
        ):
            raise ValueError("invalid or duplicate workspace id")
        for field in ("work_dir", "state_path"):
            value = workspace[field]
            if not isinstance(value, str) or not value or len(value) > 8192:
                raise ValueError("invalid workspace path")
            value.encode("utf-8")
        if (
            type(workspace["enable_board"]) is not bool
            or type(workspace["running"]) is not bool
            or type(workspace["session_count"]) is not int
            or not 0 <= workspace["session_count"] <= 1000000
        ):
            raise ValueError("invalid workspace inventory values")
        seen.add(workspace_id)
    return workspaces


class Router:
    def __init__(self, connect_timeout=10, max_connections=64):
        self.connect_timeout = connect_timeout
        self.max_connections = max_connections
        self.nodes = {}
        self.streams = {}
        self.browser_token = ""
        self.blocked_ips = set()

    async def control(self, websocket):
        if websocket.headers.get("origin"):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        node = None
        try:
            message = await asyncio.wait_for(control_message(websocket), 10)
            node_id = device_id(message["identity_key"])
            if (
                message.get("type") != "register"
                or message.get("version") != 2
                or "id" in message
                or not isinstance(message["name"], str)
                or not message["name"]
                or len(message["name"]) > 256
                or any(ord(char) < 32 for char in message["name"])
                or type(message["port"]) is not int
                or not 0 <= message["port"] <= 65535
            ):
                raise ValueError("invalid router registration")
            message["name"].encode("utf-8")
            name = "{0}/{1}:{2}".format(
                message["name"], websocket.client.host, message["port"]
            )
            if node_id in self.nodes:
                await websocket.send_text(encode({"type": "rejected"}))
                await close_websocket(websocket, 1008)
                return
            node = Node(
                websocket,
                node_id,
                name,
                validate_inventory(message["workspaces"]),
            )
            self.nodes[node_id] = node
            await websocket.send_text(encode({"type": "registered", "id": node_id}))
            while True:
                message = await control_message(websocket)
                if message.get("type") != "workspaces":
                    raise ValueError("unknown router control message")
                node.workspaces = validate_inventory(message["workspaces"])
        except WebSocketDisconnect:
            pass
        except (ValueError, KeyError, TypeError, asyncio.TimeoutError):
            await close_websocket(websocket, 1008)
        finally:
            if node is not None:
                self.nodes.pop(node.id, None)
                for stream in tuple(node.streams.values()):
                    if not stream.ready.done():
                        stream.ready.set_result(None)
                    if stream.websocket is not None:
                        await close_websocket(stream.websocket, 1012)
                    stream.done.set()

    async def data(self, websocket):
        if websocket.headers.get("origin"):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        stream = None
        try:
            message = await asyncio.wait_for(control_message(websocket), 10)
            stream = self.streams.get(message["stream_id"])
            if (
                stream is None
                or stream.ready.done()
                or device_id(message["identity_key"]) != stream.node_id
            ):
                await close_websocket(websocket, 1008)
                return
            stream.websocket = websocket
            stream.ready.set_result(websocket)
            await stream.done.wait()
        except WebSocketDisconnect:
            pass
        except (ValueError, KeyError, TypeError, asyncio.TimeoutError):
            await close_websocket(websocket, 1008)
        finally:
            await close_websocket(websocket)

    @asynccontextmanager
    async def connection(self, node_id):
        node = self.nodes.get(node_id)
        if node is None:
            raise TunnelUnavailable("Workspace device is offline.")
        if len(node.streams) >= self.max_connections:
            raise TunnelUnavailable("Workspace device has too many open requests.")
        stream_id = uuid4().hex
        stream = Stream(node_id)
        node.streams[stream_id] = stream
        self.streams[stream_id] = stream
        try:
            async with node.send_lock:
                await node.websocket.send_text(
                    encode(
                        {
                            "type": "connect",
                            "stream_id": stream_id,
                        }
                    )
                )
            websocket = await asyncio.wait_for(stream.ready, self.connect_timeout)
            if websocket is None:
                raise TunnelUnavailable("Workspace device disconnected.")
            yield websocket
        except (WebSocketDisconnect, OSError, asyncio.TimeoutError) as exc:
            raise TunnelUnavailable(
                "Connection lost. Check the session before retrying a message."
            ) from exc
        finally:
            self.streams.pop(stream_id, None)
            node.streams.pop(stream_id, None)
            stream.done.set()

    async def proxy(self, scope, receive, send):
        connection = HTTPConnection(scope)
        blocked = connection.client.host in self.blocked_ips
        if blocked or not _auth_cookie_matches(
            self.browser_token, connection.cookies.get("pycodex_router_auth")
        ):
            await require_login(scope, receive, send)
            return
        started = False

        async def requests(websocket):
            while True:
                message = await receive()
                await send_event(websocket.send_text, message)
                if message["type"] in {"http.disconnect", "websocket.disconnect"}:
                    return

        async def responses(websocket):
            nonlocal started
            allowed = (
                {"http.response.start", "http.response.body"}
                if scope["type"] == "http"
                else {"websocket.accept", "websocket.send", "websocket.close"}
            )
            while True:
                message = decode(await websocket.receive_text())
                if message.get("type") not in allowed:
                    raise ValueError("invalid router response event")
                if "headers" in message:
                    message["headers"] = response_headers(
                        message["headers"],
                        scope.get("root_path", ""),
                        scope["scheme"] in {"https", "wss"},
                    )
                await send(message)
                started = True
                if (
                    message["type"] == "websocket.close"
                    or message["type"] == "http.response.body"
                    and not message.get("more_body", False)
                ):
                    return

        try:
            async with self.connection(scope["path_params"]["node_id"]) as websocket:
                await websocket.send_text(
                    encode(
                        {
                            "type": "open",
                            "scope": request_scope(scope),
                        }
                    )
                )
                tasks = [
                    asyncio.create_task(requests(websocket)),
                    asyncio.create_task(responses(websocket)),
                ]
                try:
                    done, _pending = await asyncio.wait(
                        tasks, return_when=asyncio.FIRST_COMPLETED
                    )
                    for task in done:
                        task.result()
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
        except TunnelUnavailable as exc:
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1013})
            elif not started:
                await JSONResponse({"error": str(exc)}, status_code=503)(
                    scope, receive, send
                )
            else:
                # Closing an incomplete HTTP response must stay visible to the caller.
                raise

    async def workspaces(self, request):
        nodes = []
        workspaces = []
        for node in sorted(self.nodes.values(), key=lambda item: item.id):
            base = device_url(
                request,
                node.id,
                request.scope.get("root_path", "") + "/n/" + node.id + "/",
            )
            nodes.append({"id": node.id, "name": node.name, "url": base})
            for workspace in node.workspaces:
                item = dict(workspace)
                item.update(
                    {
                        "node_id": node.id,
                        "node_name": node.name,
                        "url": base + "w/" + workspace["id"] + "/",
                    }
                )
                workspaces.append(item)
        return JSONResponse({"nodes": nodes, "workspaces": workspaces})

    async def close(self):
        for node in tuple(self.nodes.values()):
            await close_websocket(node.websocket, 1001)


def create_app(password=None, connect_timeout=10, max_connections=64):
    router = Router(connect_timeout, max_connections)

    async def index(request):
        return HTMLResponse(
            Path(__file__).with_name("index.html").read_text(encoding="utf-8"),
            headers={"Cache-Control": "no-store"},
        )

    web = Starlette(
        routes=[
            Route("/", index),
            Route("/api/workspaces", router.workspaces),
            Mount("/n/{node_id}", app=redirect_device),
        ]
    )
    router.browser_token = _install_auth(
        web,
        password,
        cookie_name="pycodex_router_auth",
        login_title="pycodex router",
        blocked_ips=router.blocked_ips,
    )

    @asynccontextmanager
    async def lifespan(app):
        try:
            yield
        finally:
            await router.close()

    node_web = Starlette(routes=[Mount("/n/{node_id}", app=router.proxy)])
    app = Starlette(
        routes=[Mount("/", app=BrowserOrigins(router, web, node_web))],
        lifespan=lifespan,
    )
    app.state.router = router
    return app


def create_tunnel_app(router):
    return Starlette(
        routes=[
            WebSocketRoute("/tunnel/control", router.control),
            WebSocketRoute("/tunnel/data", router.data),
        ]
    )


def build_parser():
    parser = argparse.ArgumentParser(
        prog="pycodex-router",
        description="Publish reverse-connected pycodex workspaces.",
        epilog=(
            "Use a dedicated router domain with wildcard DNS; terminate HTTPS/WSS "
            "and the wildcard certificate at your reverse proxy."
        ),
    )
    parser.add_argument("--listen", default="0.0.0.0:6007", help="Browser host:port.")
    parser.add_argument(
        "--tunnel-listen", default="0.0.0.0:6000", help="Device host:port."
    )
    parser.add_argument(
        "--password",
        required=True,
        help="Password required for browser access to the router.",
    )
    return parser


def main(argv=None):
    import uvicorn

    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.password:
        parser.error("--password must not be empty")
    app = create_app(args.password)
    tunnel_app = create_tunnel_app(app.state.router)
    addresses = [parse_listen(args.listen), parse_listen(args.tunnel_listen)]
    if addresses[0][1] != 0 and addresses[0][1] == addresses[1][1]:
        parser.error("browser and device listeners must use different ports")
    sockets = []

    async def dispatch(scope, receive, send):
        # The accepted socket's local port cannot be forged with HTTP headers.
        target = (
            app
            if (
                scope["type"] == "lifespan"
                or scope["server"][1] == sockets[0].getsockname()[1]
            )
            else tunnel_app
        )
        await target(scope, receive, send)

    try:
        config = None
        for host, port in addresses:
            listener = uvicorn.Config(
                dispatch,
                host=host,
                port=port,
                loop="asyncio",
                ws="websockets",
                ws_max_size=32 * 1024 * 1024,
            )
            sockets.append(listener.bind_socket())
            if config is None:
                config = listener
        if sockets[0].getsockname()[1] == sockets[1].getsockname()[1]:
            raise ValueError("browser and device listeners must use different ports")
        uvicorn.Server(config).run(sockets=sockets)
    finally:
        for listener_socket in sockets:
            listener_socket.close()
    return 0
