"""Same-user HTTP access to existing local and registered-device APIs."""

from urllib.parse import unquote, urlsplit, urlunsplit

import requests
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from pycodex_router.protocol import agent_api_request


class AgentSocketAccess:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        socket_path = getattr(self.app.state, "agent_socket_path", None)
        # Uvicorn gets this address from the socket, independently of HTTP headers.
        if (
            scope["type"] != "http" or socket_path is None
            or scope["server"] not in (None, (socket_path, None))
        ):
            await self.app(scope, receive, send)
            return
        scope = dict(scope)
        scope["pycodex.agent_access"] = True
        if not scope["path"].startswith("/router/"):
            await self.app(scope, receive, send)
            return
        client = getattr(self.app.state, "router_client", None)
        if client is None or not client.connected or client.api_url is None:
            await JSONResponse({"error": "router API is unavailable"}, 503)(scope, receive, send)
            return
        remote = urlsplit(client.api_url)
        scope["path"] = scope["path"][len("/router"):]
        scope["root_path"] = unquote(remote.path)
        if not scope["path"].startswith(scope["root_path"] + "/") or not agent_api_request(scope):
            await JSONResponse({"error": "not a session API"}, 403)(scope, receive, send)
            return
        url = urlunsplit((
            remote.scheme, remote.netloc,
            scope["raw_path"][len(b"/router"):].decode("ascii"),
            scope["query_string"].decode("ascii"), "",
        ))
        body = await Request(scope, receive).body()

        def forward():
            with requests.Session() as session:
                session.trust_env = False
                result = session.request(
                    scope["method"], url, data=body,
                    headers={"Authorization": "Bearer " + client._identity_key,
                             "Content-Type": "application/json"},
                    allow_redirects=False, timeout=(10, 30),
                )
                return Response(
                    result.content, result.status_code,
                    media_type=result.headers.get("content-type", "application/json"),
                )

        try:
            response = await run_in_threadpool(forward)
        except requests.RequestException:
            response = JSONResponse({"error": "router API is unavailable"}, 503)
        await response(scope, receive, send)
