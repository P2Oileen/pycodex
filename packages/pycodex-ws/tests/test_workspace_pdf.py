from pathlib import Path
from urllib.parse import quote

import pytest
from starlette.testclient import TestClient

from test_workspace_server import make_session
from workspace_server import (
    WorkspaceDefinition, WorkspaceEntry, WorkspaceRegistry, WorkspaceSessionManager,
    create_app, create_multi_workspace_app,
)
from workspace_server.workspace_views import WorkspaceViewOpener, WorkspaceViewStore


def write_pdf(path, text="PDF preview", padding=0):
    content = b"BT /F1 24 Tf 72 720 Td (" + text.encode("ascii") + b") Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n"
        + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(padding).encode("ascii") + b" >>\nstream\n"
        + b"\0" * padding + b"\nendstream",
    ]
    data = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(("{0} 0 obj\n".format(index)).encode("ascii") + obj + b"\nendobj\n")
    xref = len(data)
    data.extend(("xref\n0 {0}\n0000000000 65535 f \n".format(len(offsets))).encode("ascii"))
    for offset in offsets[1:]:
        data.extend(("{0:010d} 00000 n \n".format(offset)).encode("ascii"))
    data.extend((
        "trailer\n<< /Size {0} /Root 1 0 R >>\nstartxref\n{1}\n%%EOF\n"
    ).format(len(offsets), xref).encode("ascii"))
    Path(path).write_bytes(data)
    return bytes(data)


@pytest.mark.parametrize("multi", [False, True])
def test_pdf_routes_stream_large_files_and_preserve_authentication(tmp_path, multi):
    path = tmp_path / "测试 report.PDF"
    data = write_pdf(path, padding=WorkspaceViewStore.max_file_bytes + 1)
    state = tmp_path / "state"
    manager = WorkspaceSessionManager(lambda: make_session(cwd=tmp_path), state)
    if multi:
        app = create_multi_workspace_app(WorkspaceRegistry([
            WorkspaceEntry(WorkspaceDefinition("first", state, tmp_path, False), manager),
            WorkspaceEntry(
                WorkspaceDefinition("second", tmp_path / "second", tmp_path, False),
                WorkspaceSessionManager(make_session),
            ),
        ]), password="pdf-test-password")
        prefix = "/w/first"
    else:
        app = create_app(manager, state, password="pdf-test-password", work_dir=tmp_path, enable_board=False)
        prefix = ""
    with TestClient(app) as browser:
        assert browser.get(prefix + "/api/views/unknown/pdf").status_code == 401
        assert browser.head(prefix + "/api/views/unknown/pdf").status_code == 401
        assert browser.post("/login", json={"password": "pdf-test-password"}).status_code == 200
        response = browser.post(prefix + "/api/views/open", json={"href": path.name})
        assert response.status_code == 200
        view = response.json()["view"]
        assert view["documents"][0]["media_type"] == "application/pdf"
        assert "text" not in view["documents"][0]
        assert "image_url" not in view["documents"][0]
        assert len(response.content) < 2048
        assert (tmp_path / "state.pycodex-views.json").stat().st_size < 2048
        url = prefix + "/api/views/" + view["id"] + "/pdf"
        pdf = browser.get(url)
        assert pdf.status_code == 200
        assert pdf.content == data
        assert pdf.headers["content-type"] == "application/pdf"
        assert pdf.headers["content-disposition"] == "inline; filename*=utf-8''" + quote(path.name, safe="")
        assert pdf.headers["x-content-type-options"] == "nosniff"
        assert pdf.headers["cache-control"] == "no-store"
        head = browser.head(url)
        assert head.status_code == 200 and head.content == b""
        assert int(head.headers["content-length"]) == len(data)
        assert browser.get(url + "?download=true").headers["content-disposition"].startswith("attachment;")
        (tmp_path / "private.txt").write_text("not a PDF", encoding="utf-8")
        assert browser.get(url, params={"path": "private.txt"}).content == data
        non_pdf = browser.post(prefix + "/api/views/open", json={"href": "private.txt"}).json()["view"]
        assert browser.get(prefix + "/api/views/" + non_pdf["id"] + "/pdf").status_code == 400
        if multi:
            assert browser.get("/w/second/api/views/" + view["id"] + "/pdf").status_code == 404
        saved = WorkspaceViewStore(tmp_path / "state.pycodex-views.json")
        assert saved.get(view["id"])["documents"][0]["media_type"] == "application/pdf"
        browser.cookies.clear()
        assert browser.get(url).status_code == 401
        browser.post("/login", json={"password": "pdf-test-password"})
        assert browser.put(prefix + "/api/share", json={"password": "pdf-visitor"}).status_code == 200
        browser.cookies.clear()
        assert browser.post(
            "/login", params={"next": prefix + "/"}, json={"password": "pdf-visitor"},
        ).status_code == 200
        assert browser.get(url).content == data
        if multi:
            assert browser.get("/w/second/api/views/" + view["id"] + "/pdf").status_code == 401
        browser.cookies.clear()
        browser.post("/login", json={"password": "pdf-test-password"})
        assert browser.delete(prefix + "/api/share").status_code == 200
        assert browser.delete(prefix + "/api/views/" + view["id"]).status_code == 200
        assert browser.get(url).status_code == 404


def test_pdf_refresh_and_invalid_content(tmp_path):
    path = tmp_path / "report.pdf"
    write_pdf(path)
    manager = WorkspaceSessionManager(make_session)
    with TestClient(create_app(manager, None, work_dir=tmp_path, enable_board=False)) as browser:
        view = browser.post("/api/views/open", json={"href": path.name}).json()["view"]
        url = "/api/views/" + view["id"]
        revision = view["revision"]
        assert browser.get(url).json()["revision"] == revision
        updated = write_pdf(path, "Updated preview")
        refreshed = browser.get(url).json()
        assert refreshed["revision"] == revision + 1
        assert browser.get(url + "/pdf").content == updated
        assert browser.get(url).json()["revision"] == refreshed["revision"]
        path.write_text("<html>wrong content</html>", encoding="utf-8")
        assert browser.get(url + "/pdf").status_code == 400
        assert "invalid PDF header" in browser.get(url).json()["documents"][0]["error"]
        write_pdf(path)
        assert browser.get(url + "/pdf").status_code == 200
        path.unlink()
        assert browser.get(url + "/pdf").status_code == 404


def test_pdf_header_and_line_selection_are_validated(tmp_path):
    path = tmp_path / "report.pdf"
    path.write_text("not a PDF", encoding="utf-8")
    views = WorkspaceViewStore()
    opener = WorkspaceViewOpener(views, tmp_path)
    with pytest.raises(ValueError, match="invalid PDF header"):
        opener.open(path.name)
    write_pdf(path)
    with pytest.raises(ValueError, match="line selection requires an existing text file"):
        opener.open(path.name + "#L1")
    assert views.list_views() == []
