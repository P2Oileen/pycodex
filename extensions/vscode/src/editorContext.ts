import { basename } from "node:path";
import type { Selection, TextDocument, WorkspaceFolder } from "vscode";

export interface ContextBlock {
  label: string;
  text: string;
}

export interface CapturedContext {
  folder: WorkspaceFolder;
  blocks: ContextBlock[];
}

/** Capture an editable text block once, before any asynchronous operation. */
export function editorContext(document: TextDocument, selection?: Selection): ContextBlock {
  const selected = selection && !selection.isEmpty;
  const first = !selection ? 0 : selected ? selection.start.line : Math.max(0, selection.active.line - 10);
  const last = !selection ? document.lineCount - 1 : selected
    ? selection.end.line - (
      selection.end.character === 0 && selection.end.line > first ? 1 : 0
    )
    : Math.min(document.lineCount - 1, selection.active.line + 10);
  const excerpt: string[] = [];
  let remaining = 12_000;
  let truncated = false;
  for (let index = first; index <= last; index += 1) {
    if (excerpt.length === 200 || remaining <= 0) {
      truncated = true;
      break;
    }
    let text = document.lineAt(index).text;
    if (selection && selected) {
      const start = index === selection.start.line ? selection.start.character : 0;
      const end = index === selection.end.line ? selection.end.character : text.length;
      text = text.slice(start, end);
    }
    if (text.length > remaining) truncated = true;
    excerpt.push(`${index + 1}: ${text.slice(0, remaining)}`);
    remaining -= text.length + 1;
  }
  const text = [
    "<editor_context>",
    `File: ${JSON.stringify(document.uri.fsPath)}`,
    `URI: ${JSON.stringify(document.uri.toString())}`,
    `Language: ${document.languageId}`,
    ...(selection ? [
      `Cursor: line ${selection.active.line + 1}, column ${selection.active.character + 1} (1-based)`,
      selected
        ? `Selection: ${selection.start.line + 1}:${selection.start.character + 1}–${selection.end.line + 1}:${selection.end.character + 1} (end exclusive)`
        : "Selection: none",
    ] : []),
    `Document version: ${document.version}`,
    `Unsaved changes: ${document.isDirty}`,
    `Source: editor buffer; ${!selection ? "file contents" : selected ? "selected text" : "nearby lines"}${truncated ? " (excerpt truncated)" : ""}`,
    ...excerpt,
    "</editor_context>",
  ].join("\n");
  const location = selection ? selected ? `${first + 1}–${last + 1}` : String(selection.active.line + 1) : "";
  return {
    label: `${basename(document.uri.fsPath)}${location ? `:${location}` : ""}${document.uri.scheme === "git" ? " (Git)" : ""}`,
    text,
  };
}
