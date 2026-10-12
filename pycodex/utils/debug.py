import os
import typing
from pathlib import Path


def get_debug_dir() -> "typing.Union[Path, None]":
    value = os.environ.get("PYCODEX_DEBUG_LOG", "").strip()
    if not value:
        return None
    path = Path(value).expanduser()
    path.mkdir(parents=True, exist_ok=True)
    return path


def debug(stop: "bool" = False):
    import socket

    import debugpy

    if debugpy.is_client_connected():
        return
    try:
        host = socket.gethostbyname(socket.getfqdn(socket.gethostname()))
        port = 5000

        debugpy.listen((host, port), in_process_debug_adapter=False)
        print("Waiting for debugger...\a")
        print(f"ip: {host} port:{port}", flush=True)
        debugpy.wait_for_client()
        print("Connected.")
        if stop:
            debugpy.breakpoint()
    except Exception as e:
        import traceback

        print("\n".join(traceback.format_exception(e)))
