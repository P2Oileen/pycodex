import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/features/bracketMatching/register.js";
import "monaco-editor/features/clipboard/register.js";
import "monaco-editor/features/codeEditor/register.js";
import "monaco-editor/features/codicon/register.js";
import "monaco-editor/features/contextmenu/register.js";
import "monaco-editor/features/diffEditor/register.js";
import "monaco-editor/features/find/register.js";
import "monaco-editor/features/folding/register.js";
import "monaco-editor/features/gotoLine/register.js";
import "monaco-editor/features/hover/register.js";
import "monaco-editor/features/lineSelection/register.js";
import "monaco-editor/features/links/register.js";
import "monaco-editor/features/readOnlyMessage/register.js";
import "monaco-editor/features/tokenization/register.js";
import "monaco-editor/features/unicodeHighlighter/register.js";
import "monaco-editor/features/wordHighlighter/register.js";
import "monaco-editor/features/wordOperations/register.js";
import "monaco-editor/features/wordPartOperations/register.js";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/languages/definitions/register.all.js";
import {createTokenizationSupport} from "monaco-editor/languages/features/json/tokenization.js";
import {CommonFindController} from "monaco-editor/editor/contrib/find/browser/findController.js";
import {IEditorWorkerService} from "monaco-editor/editor/common/services/editorWorker.js";
import {StandaloneServices} from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import workerSource from "workspace-editor-worker";
import {editorContext} from "./editor_context.mjs";
import "./editor.css";

function editorWorkerFactory() {
  // One script URL belongs to the Monaco runtime, including bfcache restores.
  // The browser releases it with the document.
  const url = URL.createObjectURL(new Blob([workerSource], {type: "text/javascript"}));
  return (moduleId, label) => new Worker(url, {name: label});
}

// Monaco requires this global host hook to create its editor/diff worker.
globalThis.MonacoEnvironment = {getWorker: editorWorkerFactory()};
// The JSON language-service entry also imports all editor contributions.
// This read-only viewer needs its tokenizer and language configuration only.
monaco.languages.register({
  id: "json",
  extensions: [".json", ".bowerrc", ".jshintrc", ".jscsrc", ".eslintrc", ".babelrc", ".har"],
  aliases: ["JSON", "json"],
  mimetypes: ["application/json"],
});
monaco.languages.setTokensProvider("json", createTokenizationSupport(true));
monaco.languages.setLanguageConfiguration("json", {
  wordPattern: /(-?\d*\.\d\w*)|([^\[\{\]\}\:\"\,\s]+)/g,
  comments: {lineComment: "//", blockComment: ["/*", "*/"]},
  brackets: [["{", "}"], ["[", "]"]],
  autoClosingPairs: [
    {open: "{", close: "}", notIn: ["string"]},
    {open: "[", close: "]", notIn: ["string"]},
    {open: '"', close: '"', notIn: ["string"]},
  ],
});

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

class SnapshotEditor {
  constructor(parent, snapshot, saved = {}, onInsertContext = null) {
    this.parent = parent;
    this.document = parent.ownerDocument;
    this.snapshot = snapshot;
    this.onInsertContext = onInsertContext;
    this.contextKeys = [];
    this.isDiff = snapshot.kind === "diff";
    this.activeSide = saved.activeSide || (this.isDiff ? "modified" : "file");
    this.revealOriginal = saved.revealOriginal || false;
    this.wrap = saved.wrap || false;
    this.disposables = [];
    this.titles = [];
    this.destroyed = false;
    this.updateGeneration = 0;
    this.toolbar = element(this.document, "div", "editor-toolbar");
    this.body = element(this.document, "div", "editor-body");
    this.buildToolbar();
    parent.appendChild(this.toolbar);
    parent.appendChild(this.body);
    this.models = snapshot.documents.map((source, index) => {
      const filename = source.label.replace(/\\/g, "/").split("/").pop().split(":").pop();
      return monaco.editor.createModel(source.text, undefined, monaco.Uri.from({
        scheme: "workspace-snapshot",
        path: "/" + snapshot.id + "/" + index + "/" + filename,
      }));
    });
    const options = {
      readOnly: true,
      domReadOnly: true,
      // Use the native readonly textarea to suppress the mobile keyboard.
      editContext: false,
      theme: "vs",
      fontSize: 13,
      lineHeight: 20,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      minimap: {enabled: false},
      scrollBeyondLastLine: false,
      wordWrap: this.wrap ? "on" : "off",
      padding: {top: 10, bottom: 10},
      renderLineHighlight: "all",
      overviewRulerBorder: false,
    };
    if (this.isDiff) {
      this.editor = monaco.editor.createDiffEditor(this.body, {
        ...options,
        originalEditable: false,
        renderGutterMenu: false,
        ignoreTrimWhitespace: false,
        renderSideBySide: this.body.clientWidth >= 720,
        renderSideBySideInlineBreakpoint: 720,
        diffWordWrap: this.wrap ? "on" : "off",
      });
      this.codeEditors = {
        original: this.editor.getOriginalEditor(),
        modified: this.editor.getModifiedEditor(),
      };
      this.disposables.push(this.editor.onDidUpdateDiff(() => this.updateChanges()));
      this.editor.setModel({original: this.models[0], modified: this.models[1]});
      this.updateChanges();
    } else {
      this.editor = monaco.editor.create(this.body, {
        ...options, model: this.models[0], ariaLabel: snapshot.documents[0].label + " (read only)",
      });
      this.codeEditors = {file: this.editor};
    }
    for (const [side, editor] of Object.entries(this.codeEditors)) {
      this.disposables.push(editor.onDidFocusEditorWidget(() => {
        this.activeSide = side;
        if (side === "modified" && this.revealOriginal) {
          this.revealOriginal = false;
          this.layout();
        }
        this.updateContextActions();
      }));
      if (this.onInsertContext) {
        this.contextKeys.push([
          editor, editor.createContextKey("pycodexContextAvailable", this.hasContext(editor)),
        ]);
        this.disposables.push(
          editor.addAction({
            id: "pycodex.insertContext",
            label: "Insert into chat",
            precondition: "pycodexContextAvailable",
            contextMenuGroupId: "navigation",
            contextMenuOrder: 1,
            run: () => this.insertContext(editor),
          }),
          editor.onDidChangeCursorSelection(() => this.updateContextActions()),
        );
      }
      if (this.isDiff) {
        editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.UpArrow, () => this.jump("previous"));
        editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.DownArrow, () => this.jump("next"));
      }
    }
    this.observer = new this.document.defaultView.ResizeObserver(() => this.layout());
    this.observer.observe(this.body);
    this.layout();
  }

  buildToolbar() {
    const titles = element(this.document, "div", "editor-titles");
    titles.addEventListener("wheel", event => {
      if (event.ctrlKey || event.shiftKey || event.deltaX !== 0 || event.deltaY === 0) return;
      const previous = titles.scrollLeft;
      const unit = event.deltaMode === 1 ? titles.clientHeight : event.deltaMode === 2 ? titles.clientWidth : 1;
      titles.scrollLeft += event.deltaY * unit;
      if (titles.scrollLeft !== previous) event.preventDefault();
    }, {passive: false});
    this.snapshot.documents.forEach((source, index) => {
      if (index) titles.appendChild(element(this.document, "span", "editor-title-arrow", "→"));
      const title = element(this.document, "span", "editor-title", source.label);
      if (source.missing) title.textContent += " (missing)";
      title.title = source.label;
      this.titles.push(title);
      titles.appendChild(title);
    });
    this.toolbar.appendChild(titles);
    const actions = element(this.document, "div", "editor-actions");
    if (this.onInsertContext) {
      this.insertButton = this.button(actions, "Insert selection into current chat",
        "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5M16 3h5v5m0-5-8 8",
        () => this.insertContext());
      this.insertButton.classList.add("editor-context-action");
      this.insertButton.appendChild(element(this.document, "span", "", "Insert into chat"));
      this.insertButton.hidden = true;
      this.insertButton.addEventListener("pointerdown", event => event.preventDefault());
    }
    if (this.isDiff) {
      this.changeCount = element(this.document, "span", "editor-change-count");
      this.toolbar.appendChild(this.changeCount);
      this.previous = this.button(actions, "Previous change (Alt+↑)", "M12 19V5m-6 6 6-6 6 6",
        () => this.jump("previous"));
      this.next = this.button(actions, "Next change (Alt+↓)", "M12 5v14m-6-6 6 6 6-6",
        () => this.jump("next"));
    }
    this.button(actions, "Find (Ctrl/⌘+F)", "m21 21-5.2-5.2M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
      () => this.activeEditor().getAction("actions.find").run());
    this.wrapButton = this.button(actions, "Wrap long lines", "M3 6h18M3 12h14a3 3 0 0 1 0 6h-3m3-3-3 3 3 3M3 18h5",
      () => {
        this.wrap = !this.wrap;
        this.wrapButton.setAttribute("aria-pressed", String(this.wrap));
        const wordWrap = this.wrap ? "on" : "off";
        this.editor.updateOptions(this.isDiff ? {diffWordWrap: wordWrap} : {wordWrap});
      });
    this.wrapButton.setAttribute("aria-pressed", String(this.wrap));
    this.toolbar.appendChild(actions);
  }

  button(parent, label, path, action) {
    const button = element(this.document, "button", "editor-action");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="' + path + '"/></svg>';
    button.addEventListener("click", action);
    parent.appendChild(button);
    return button;
  }

  activeEditor() {
    return this.isDiff && this.parent.dataset.layout === "unified" ?
      this.codeEditors.modified : this.codeEditors[this.activeSide];
  }

  hasContext(editor) {
    const index = this.isDiff && editor === this.codeEditors.modified ? 1 : 0;
    const source = this.snapshot.documents[index];
    return !source.missing && !source.error;
  }

  updateContextActions() {
    if (this.destroyed || !this.onInsertContext) return;
    for (const [editor, key] of this.contextKeys) key.set(this.hasContext(editor));
    const editor = this.activeEditor();
    this.insertButton.hidden = !this.hasContext(editor) || editor.getSelection().isEmpty();
  }

  insertContext(editor = this.activeEditor()) {
    if (this.destroyed || !this.hasContext(editor)) return;
    const index = this.isDiff && editor === this.codeEditors.modified ? 1 : 0;
    this.onInsertContext(editorContext(this.snapshot, index, editor.getModel(), editor.getSelection()));
  }

  jump(direction) {
    this.editor.goToDiff(direction);
    this.editor.getModifiedEditor().focus();
  }

  updateChanges() {
    const changes = this.editor.getLineChanges();
    this.previous.disabled = this.next.disabled = changes === null || changes.length === 0;
    this.changeCount.textContent = changes === null ? "Comparing…" : changes.length === 0 ?
      "No changes" : changes.length + (changes.length === 1 ? " change" : " changes");
    this.changeCount.title = this.changeCount.textContent;
  }

  async update(snapshot) {
    const generation = ++this.updateGeneration;
    const changed = snapshot.documents.some((source, index) =>
      source.text !== this.snapshot.documents[index].text);
    if (changed) {
      const worker = StandaloneServices.get(IEditorWorkerService);
      let edits;
      try {
        edits = await Promise.all(snapshot.documents.map((source, index) =>
          source.text === this.snapshot.documents[index].text ? [] :
            worker.computeMoreMinimalEdits(this.models[index].uri, [{
              range: this.models[index].getFullModelRange(), text: source.text,
            }])));
      } catch (error) {
        if (this.destroyed || generation !== this.updateGeneration) return;
        throw error;
      }
      if (this.destroyed || generation !== this.updateGeneration) return;
      const state = this.editor.saveViewState();
      edits.forEach((changes, index) => {
        if (changes.length) this.models[index].applyEdits(changes);
      });
      this.editor.restoreViewState(state);
    }
    snapshot.documents.forEach((source, index) => {
      this.titles[index].textContent = source.label + (source.missing ? " (missing)" : "");
    });
    this.snapshot = snapshot;
    this.updateContextActions();
  }

  async revealLine(document, line, isCurrent) {
    if (this.isDiff) await this.editor.waitForDiff();
    if (this.destroyed || !isCurrent()) return false;
    const model = this.models[document];
    if (line > model.getLineCount()) throw new Error(`Line ${line} is outside the file.`);
    this.activeSide = this.isDiff ? (document === 0 ? "original" : "modified") : "file";
    this.revealOriginal = this.isDiff && document === 0;
    this.layout();
    const editor = this.codeEditors[this.activeSide];
    editor.setSelection({
      startLineNumber: line, startColumn: 1,
      endLineNumber: line, endColumn: model.getLineMaxColumn(line),
    });
    editor.revealLineInCenter(line, monaco.editor.ScrollType.Immediate);
    editor.focus();
    return true;
  }

  layout() {
    const width = this.body.clientWidth;
    const height = this.body.clientHeight;
    if (this.destroyed || !width || !height) return;
    const mode = this.isDiff ? (width >= 720 || this.revealOriginal ? "split" : "unified") : "file";
    if (this.isDiff) {
      this.editor.updateOptions({
        renderSideBySide: mode === "split",
        renderSideBySideInlineBreakpoint: this.revealOriginal ? 0 : 720,
      });
    }
    this.parent.dataset.layout = mode;
    this.editor.layout({width, height});
    this.updateContextActions();
  }

  async restore(saved) {
    if (!saved) return;
    this.editor.restoreViewState(saved.viewState);
    for (const [side, editor] of Object.entries(this.codeEditors)) {
      const query = saved.find[side];
      const controller = CommonFindController.get(editor);
      if (query.isRevealed) {
        await controller.start({
          forceRevealReplace: false,
          seedSearchStringFromSelection: "none",
          seedSearchStringFromGlobalClipboard: false,
          shouldFocus: 0,
          shouldAnimate: false,
          updateSearchScope: false,
          loop: true,
        }, query);
      } else {
        controller.getState().change(query, false, false);
      }
    }
  }

  capture() {
    const find = {};
    for (const [side, editor] of Object.entries(this.codeEditors)) {
      const state = CommonFindController.get(editor).getState();
      find[side] = {
        searchString: state.searchString,
        isRevealed: state.isRevealed,
        isRegex: state.actualIsRegex,
        matchCase: state.actualMatchCase,
        wholeWord: state.actualWholeWord,
        searchScope: state.searchScope,
      };
    }
    return {
      viewState: this.editor.saveViewState(), find,
      activeSide: this.activeSide, wrap: this.wrap, revealOriginal: this.revealOriginal,
    };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.observer.disconnect();
    this.disposables.forEach(disposable => disposable.dispose());
    this.editor.dispose();
    this.models.forEach(model => model.dispose());
    this.parent.textContent = "";
  }
}

export async function createSnapshotEditor(parent, snapshot, savedState, onInsertContext) {
  const editor = new SnapshotEditor(parent, snapshot, savedState, onInsertContext);
  try {
    await editor.restore(savedState);
  } catch (error) {
    editor.destroy();
    throw error;
  }
  return editor;
}
