import os
import socket
import tempfile
import threading
from contextlib import ExitStack

from .agent_access import AgentSocketAccess


def run_owned_server(app, host, port, input_fd):
    """Keep a server alive while its launching process holds stdin open."""
    import uvicorn

    owner_closed = threading.Event()

    def watch_owner():
        # A buffered stdin read can hold its lock across interpreter shutdown.
        while os.read(input_fd, 4096):
            pass
        owner_closed.set()

    class OwnedServer(uvicorn.Server):
        async def on_tick(self, counter):
            # Check after startup so even an early EOF goes through shutdown.
            if owner_closed.is_set():
                self.should_exit = True
            return await super().on_tick(counter)

    watcher = threading.Thread(target=watch_owner, name="workspace-owner", daemon=True)
    watcher.start()
    server = OwnedServer(uvicorn.Config(
        AgentSocketAccess(app), host=host, port=port, loop="asyncio",
    ))
    with ExitStack() as cleanup:
        listener = server.config.bind_socket()
        cleanup.callback(listener.close)
        listeners = [listener]
        local_host = {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(host, host)
        if ":" in local_host:
            local_host = "[" + local_host + "]"
        actual_port = listener.getsockname()[1]
        app.state.local_api_url = "http://{0}:{1}".format(local_host, actual_port)
        if hasattr(app.state, "router_client"):
            app.state.router_client.port = actual_port
        app.state.agent_socket_path = None
        if os.name == "posix":
            directory = cleanup.enter_context(tempfile.TemporaryDirectory(prefix="pyco-agent-"))
            private = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            cleanup.callback(private.close)
            app.state.agent_socket_path = directory + "/api.sock"
            private.bind(app.state.agent_socket_path)
            os.chmod(app.state.agent_socket_path, 0o600)
            listeners.append(private)
        try:
            server.run(sockets=listeners)
        finally:
            app.state.agent_socket_path = None
