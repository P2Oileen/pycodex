"""Workspace frontend template and static resource loading."""

import mimetypes
from html.parser import HTMLParser
from pathlib import Path

from starlette.exceptions import HTTPException
from starlette.responses import FileResponse


class _AssetInsertions(HTMLParser):
    def __init__(self, template: str, additions: dict) -> None:
        super().__init__()
        self.lines = template.splitlines(keepends=True)
        self.additions = additions
        self.positions = []

    def handle_endtag(self, tag: str) -> None:
        markup = self.additions.pop(tag, None)
        if markup is not None:
            line, column = self.getpos()
            offset = sum(len(row) for row in self.lines[:line - 1]) + column
            self.positions.append((offset, markup))


def frontend_directory() -> Path:
    return Path.home() / ".pycodex" / "frontend"


def frontend_file(name: str) -> Path:
    directory = frontend_directory().resolve()
    path = (directory / name).resolve()
    try:
        path.relative_to(directory)
    except ValueError:
        raise HTTPException(status_code=404, detail="frontend file not found")
    return path


def load_workspace_template(builtin: bool = False) -> str:
    packaged = Path(__file__).with_name("workspace.html")
    if builtin:
        return packaged.read_text(encoding="utf-8")
    try:
        template = frontend_file("workspace.html").read_text(
            encoding="utf-8", errors="replace"
        )
    except FileNotFoundError:
        template = packaged.read_text(encoding="utf-8")
    additions = {}
    for name, closing_tag, markup in [
        ("custom.css", "head", '<link rel="stylesheet" href="frontend/custom.css" data-pycodex-custom-style>'),
        ("custom.js", "body", '<script type="module" src="frontend/custom.js" data-pycodex-custom-script></script>'),
    ]:
        try:
            frontend_file(name).stat()
        except FileNotFoundError:
            continue
        additions[closing_tag] = markup
    if additions:
        parser = _AssetInsertions(template, additions)
        parser.feed(template)
        for offset, markup in reversed(parser.positions):
            template = template[:offset] + markup + "\n" + template[offset:]
    return template


def frontend_asset_response(name: str) -> FileResponse:
    path = frontend_file(name)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="frontend file not found")
    media_type = (
        "text/javascript" if path.suffix.lower() in {".js", ".mjs"}
        else mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    )
    return FileResponse(
        str(path),
        media_type=media_type,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )
