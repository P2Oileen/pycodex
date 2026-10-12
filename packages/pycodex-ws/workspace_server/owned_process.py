import os
import threading


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
    server = OwnedServer(uvicorn.Config(app, host=host, port=port, loop="asyncio"))
    server.run()
