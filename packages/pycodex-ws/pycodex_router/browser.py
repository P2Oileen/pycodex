"""Separate device origins while sharing the router's HttpOnly login."""

import ipaddress
import re
from http.cookies import SimpleCookie
from urllib.parse import urlencode, urlsplit

from starlette.exceptions import HTTPException
from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse, RedirectResponse

from .protocol import route_path


def origins(connection):
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
    origin = scheme + "://" + authority + suffix
    first, separator, parent = host.partition(".")
    node_id = first[2:] if separator and re.fullmatch("n-[a-z2-7]{52}", first) else None
    base = scheme + "://" + parent + suffix if node_id else origin
    return origin, base, node_id


def device_url(connection, node_id, path):
    if not re.fullmatch("[a-z2-7]{52}", node_id):
        raise HTTPException(404, "Invalid device id.")
    unused_origin, base, unused_node = origins(connection)
    parsed = urlsplit(base)
    if len("n-" + node_id + "." + parsed.hostname) > 253:
        raise HTTPException(400, "Router domain is too long for device subdomains.")
    try:
        ipaddress.ip_address(parsed.hostname)
    except ValueError:
        pass
    else:
        raise HTTPException(
            400,
            "Device isolation requires a dedicated router domain with wildcard DNS "
            "and, for HTTPS, a wildcard certificate; a bare IP cannot isolate pages.",
        )
    return parsed.scheme + "://n-" + node_id + "." + parsed.netloc + path


class BrowserOrigins:
    def __init__(self, router, admin_app, node_app):
        self.router = router
        self.admin_app = admin_app
        self.node_app = node_app

    async def __call__(self, scope, receive, send):
        connection = HTTPConnection(scope)
        origin, base, node_id = origins(connection)
        path = route_path(scope)

        async def secured_send(message):
            if message["type"] == "http.response.start":
                headers = []
                for name, value in message["headers"]:
                    if name.lower() == b"set-cookie" and node_id is None:
                        # Only router-controlled subdomains share this cookie;
                        # request_scope() never forwards it to a device.
                        cookies = SimpleCookie()
                        cookies.load(value.decode("latin-1"))
                        if "pycodex_router_auth" in cookies:
                            cookie = cookies["pycodex_router_auth"]
                            try:
                                ipaddress.ip_address(connection.url.hostname)
                            except ValueError:
                                cookie["domain"] = connection.url.hostname
                            value = cookie.OutputString().encode("latin-1")
                    headers.append((name, value))
                message = dict(
                    message,
                    headers=headers
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
            if node_id:
                prefix = "/n/" + node_id
                if path != prefix and not path.startswith(prefix + "/"):
                    raise HTTPException(
                        404, "Workspace route not found on this origin."
                    )
                await self.node_app(scope, receive, secured_send)
            else:
                await self.admin_app(scope, receive, secured_send)
        except HTTPException as exc:
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            else:
                await JSONResponse({"error": exc.detail}, exc.status_code)(
                    scope, receive, secured_send
                )


async def redirect_device(scope, receive, send):
    if scope["type"] != "http" or scope["method"] not in {"GET", "HEAD"}:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
        else:
            await JSONResponse({"error": "Use the device's own origin."}, 403)(
                scope, receive, send
            )
        return
    connection = HTTPConnection(scope)
    target = scope.get("root_path", "") + route_path(scope)
    if connection.url.query:
        target += "?" + connection.url.query
    await RedirectResponse(
        device_url(connection, scope["path_params"]["node_id"], target), 307
    )(scope, receive, send)


async def require_login(scope, receive, send):
    connection = HTTPConnection(scope)
    if scope["type"] == "websocket":
        await send({"type": "websocket.close", "code": 1008})
    elif "/api/" in route_path(scope) or scope["method"] not in {"GET", "HEAD"}:
        await JSONResponse({"error": "authentication required"}, 401)(
            scope, receive, send
        )
    else:
        unused_origin, base, node_id = origins(connection)
        prefix = scope.get("root_path", "")
        root = prefix[: -len("/n/" + node_id)]
        target = prefix + route_path(scope)
        if connection.url.query:
            target += "?" + connection.url.query
        await RedirectResponse(
            base + root + "/login?" + urlencode({"next": target}), 303
        )(scope, receive, send)
