const assert = require("node:assert/strict");
const { test } = require("node:test");
const { editorContext } = require("../out/editorContext");

function selection(anchorLine, anchorColumn, activeLine = anchorLine, activeColumn = anchorColumn) {
  const anchor = { line: anchorLine, character: anchorColumn };
  const active = { line: activeLine, character: activeColumn };
  const forward = anchorLine < activeLine || (anchorLine === activeLine && anchorColumn <= activeColumn);
  return {
    anchor, active,
    start: forward ? anchor : active,
    end: forward ? active : anchor,
    isEmpty: anchorLine === activeLine && anchorColumn === activeColumn,
  };
}

function document(lines, dirty = true) {
  return {
    uri: {
      fsPath: "/workspace/示例.py",
      toString: () => "vscode-remote://ssh-remote+fixture/workspace/示例.py",
    },
    languageId: "python",
    version: 4,
    isDirty: dirty,
    lineCount: lines.length,
    lineAt: index => ({ text: lines[index] }),
  };
}

test("captures a one-based location and the unsaved source buffer as an immutable message", () => {
  const lines = Array.from({ length: 100 }, (_, index) => `line_${index + 1}`);
  const source = document(lines);
  const captured = editorContext(source, selection(39, 2));
  lines[39] = "changed_after_sending";
  assert.equal(captured.label, "示例.py:40");
  assert.match(captured.text, /File: "\/workspace\/示例.py"/);
  assert.match(captured.text, /Cursor: line 40, column 3 \(1-based\)/);
  assert.match(captured.text, /Unsaved changes: true/);
  assert.match(captured.text, /40: line_40/);
  assert.doesNotMatch(captured.text, /changed_after_sending|29: line_29|51: line_51/);
});

test("reversed selections use the active caret and preserve the selected columns", () => {
  const source = document(["abcdef", "ghijkl", "mnopqr"], false);
  const context = editorContext(source, selection(2, 3, 0, 2));
  assert.equal(context.label, "示例.py:1–3");
  assert.match(context.text, /Cursor: line 1, column 3/);
  assert.match(context.text, /Selection: 1:3–3:4/);
  assert.match(context.text, /1: cdef\n2: ghijkl\n3: mno/);
  assert.match(context.text, /Unsaved changes: false/);
});

test("selection excerpts respect an exclusive end line and explicit size limits", () => {
  const short = editorContext(document(["a", "b", "c"]), selection(0, 0, 2, 0));
  assert.match(short.text, /1: a\n2: b/);
  assert.doesNotMatch(short.text, /3: c/);
  const long = editorContext(
    document(Array.from({ length: 400 }, () => "x".repeat(100))),
    selection(0, 0, 399, 100),
  );
  assert.match(long.text, /excerpt truncated/);
  assert.ok(long.text.length < 14_000);
});

test("whole-file context has a bounded excerpt without an invented cursor or selection", () => {
  const context = editorContext(document(Array.from({ length: 220 }, (_, index) => `line_${index + 1}`)));
  assert.equal(context.label, "示例.py");
  assert.match(context.text, /Source: editor buffer; file contents \(excerpt truncated\)/);
  assert.match(context.text, /200: line_200/);
  assert.doesNotMatch(context.text, /201: line_201|Cursor:|Selection:/);
});
