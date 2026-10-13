"""Browser access checks for trusted devices sharing a router origin."""

import ipaddress
import re
from urllib.parse import urlencode, urlsplit

from starlette.exceptions import HTTPException
from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse, RedirectResponse

from .protocol import route_path


def request_origin(connection):
    try:
        parsed = urlsplit("//" + connection.headers["host"])
        port = parsed.port
    except ValueError:
        raise HTTPException(400, "Invalid router host.")
    host = parsed.hostname
    if (
        not host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise HTTPException(400, "Invalid router host.")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if len(host) > 253 or any(
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
            for label in host.split(".")
        ):
            raise HTTPException(400, "Invalid router host.")
    scheme = "https" if connection.scope["scheme"] in {"https", "wss"} else "http"
    suffix = "" if port in (None, 443 if scheme == "https" else 80) else ":" + str(port)
    authority = "[" + host + "]" if ":" in host else host
    return scheme + "://" + authority + suffix


class BrowserAccess:
    def __init__(self, router, app):
        self.router = router
        self.app = app

    async def __call__(self, scope, receive, send):
        connection = HTTPConnection(scope)
        origin = request_origin(connection)

        async def secured_send(message):
            if message["type"] == "http.response.start":
                message = dict(
                    message,
                    headers=list(message["headers"])
                    + [
                        (b"content-security-policy", b"frame-ancestors 'self'"),
                        (b"x-frame-options", b"SAMEORIGIN"),
                        (b"x-content-type-options", b"nosniff"),
                        (b"referrer-policy", b"no-referrer"),
                        (b"permissions-policy", b"document-domain=()"),
                        (b"origin-agent-cluster", b"?1"),
                    ],
                )
            await send(message)

        try:
            if connection.client.host in self.router.blocked_ips:
                raise HTTPException(
                    403,
                    "Too many incorrect passwords. This IP is blocked "
                    "until the router restarts.",
                )
            if connection.headers.get("origin") not in (None, origin):
                raise HTTPException(
                    403, "Cross-origin router requests are not allowed."
                )
            await self.app(scope, receive, secured_send)
        except HTTPException as exc:
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            else:
                await JSONResponse({"error": exc.detail}, exc.status_code)(
                    scope, receive, secured_send
                )


async def require_login(scope, receive, send):
    connection = HTTPConnection(scope)
    if scope["type"] == "websocket":
        await send({"type": "websocket.close", "code": 1008})
    elif "/api/" in route_path(scope) or scope["method"] not in {"GET", "HEAD"}:
        await JSONResponse({"error": "authentication required"}, 401)(
            scope, receive, send
        )
    else:
        node_id = scope["path_params"]["node_id"]
        prefix = scope.get("root_path", "")
        root = prefix[: -len("/n/" + node_id)]
        target = prefix + route_path(scope)
        if connection.url.query:
            target += "?" + connection.url.query
        await RedirectResponse(
            root + "/login?" + urlencode({"next": target}), 303
        )(scope, receive, send)
