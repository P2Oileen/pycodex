import {tabLabels} from "./view_labels.mjs";

/** Capture the displayed text and its source before returning to the chat draft. */
export function editorContext(snapshot, documentIndex, model, selection) {
  const source = snapshot.documents[documentIndex];
  const git = source.git_source;
  const selected = selection.startLineNumber !== selection.endLineNumber ||
    selection.startColumn !== selection.endColumn;
  const first = selection.startLineNumber;
  const last = selected ? selection.endLineNumber -
    (selection.endColumn === 1 && selection.endLineNumber > first ? 1 : 0) :
    first - 1;
  const excerpt = [];
  let remaining = 12000;
  let truncated = false;
  for (let line = first; line <= last; line += 1) {
    if (excerpt.length === 200 || remaining <= 0) {
      truncated = true;
      break;
    }
    let text = model.getLineContent(line);
    if (selected) {
      text = text.slice(
        line === selection.startLineNumber ? selection.startColumn - 1 : 0,
        line === selection.endLineNumber ? selection.endColumn - 1 : text.length,
      );
    }
    if (text.length > remaining) truncated = true;
    excerpt.push(`${line}: ${text.slice(0, remaining)}`);
    remaining -= text.length + 1;
  }
  const side = snapshot.kind === "diff" ? (documentIndex === 0 ? "left (original)" : "right (modified)") : "";
  const location = selected ? `${first}–${last}` : String(selection.positionLineNumber);
  const viewLabel = tabLabels([snapshot]).get(snapshot.id);
  const label = [viewLabel.name, viewLabel.description].filter(Boolean).join(" · ");
  return {
    label: `${label} · ${side ? (documentIndex === 0 ? "left " : "right ") : ""}L${location}`,
    text: [
      "<editor_context>",
      `View: ${JSON.stringify(snapshot.title)}`,
      ...(git ? [`Git repository: ${JSON.stringify(git.repository)}`] : []),
      ...(side ? [`Diff side: ${side}`] : []),
      selected
        ? `Selection: ${selection.startLineNumber}:${selection.startColumn}–${selection.endLineNumber}:${selection.endColumn} (end exclusive)`
        : `Cursor: line ${selection.positionLineNumber}, column ${selection.positionColumn} (1-based)`,
      `Source: read-only workspace viewer; ${selected ? "selected text" : "cursor location"}${truncated ? " (excerpt truncated)" : ""}`,
      ...excerpt,
      "</editor_context>",
    ].join("\n"),
  };
}
