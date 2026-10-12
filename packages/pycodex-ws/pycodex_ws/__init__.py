"""Workspace integrations for python-codex."""

from pycodex.bootstrap import build_runtime as build_core_runtime


def build_runtime(agent):
    runtime = build_core_runtime(agent)
    link = None

    async def unlink(argument):
        nonlocal link
        if argument:
            raise ValueError("Usage: /unlink")
        if link is None:
            return {"kind": "connection", "lines": ["No Feishu card is linked."]}
        link.detach()
        link = None
        return {"kind": "connection", "lines": ["Unlinked Feishu card."]}

    async def connect(target):
        nonlocal link
        if not target:
            raise ValueError("Usage: /link <feishu-email|open_id|chat_id>")
        if link is not None:
            raise RuntimeError("A Feishu card is already linked. Use /unlink first.")
        from .feishu_link import PycodexRuntimeLink

        link = await PycodexRuntimeLink(runtime, target).start_async()
        return {
            "kind": "connection",
            "lines": [
                "Linked Feishu card: session_key={0} message_id={1}".format(
                    link.session_key,
                    link.message_id or "-",
                ),
            ],
        }

    async def close_link():
        if link is not None:
            await unlink("")

    runtime.register_command("link", connect)
    runtime.register_command("unlink", unlink)
    runtime.add_close_handler(close_link)
    return runtime
