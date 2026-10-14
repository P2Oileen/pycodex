import assert from "assert";
import {TouchSelection} from "../workspace_server/frontend/touch_selection.mjs";

function fixture(coarse = true) {
  const frames = new Map();
  const events = new Map();
  const widgets = new Set();
  const nodes = [];
  const options = {contextmenu: true};
  const layout = {
    contentLeft: 40, contentWidth: 360, verticalScrollbarWidth: 14, horizontalScrollbarHeight: 10,
  };
  let frameId = 0;
  let scrollTop = 0;
  let scrollLeft = 0;
  let selection;
  const document = {
    defaultView: {
      matchMedia: () => ({matches: coarse}),
      requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
      cancelAnimationFrame: id => frames.delete(id),
    },
    createElement() {
      const listeners = new Map();
      const captures = new Set();
      const node = {
        ownerDocument: document, style: {}, children: [], listeners, captures,
        appendChild(child) { this.children.push(child); },
        setAttribute() {},
        addEventListener(type, callback) {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type).add(callback);
        },
        removeEventListener(type, callback) { listeners.get(type).delete(callback); },
        setPointerCapture: id => captures.add(id),
        hasPointerCapture: id => captures.has(id),
        releasePointerCapture: id => captures.delete(id),
        getBoundingClientRect: () => ({left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200}),
        send(type, data = {}) {
          const event = {
            pointerType: "touch", pointerId: 1, clientX: 80, clientY: 40,
            preventDefault() { this.prevented = true; },
            stopPropagation() { this.stopped = true; },
            ...data,
          };
          for (const callback of listeners.get(type) || []) callback(event);
          return event;
        },
      };
      nodes.push(node);
      return node;
    },
  };
  const node = document.createElement();
  const emit = (name, value) => {
    for (const callback of events.get(name) || []) callback(value);
  };
  const editor = {
    getDomNode: () => node,
    getSelection: () => selection,
    getModel: () => ({
      getWordAtPosition: () => ({startColumn: 1, endColumn: 10}),
      getLineMaxColumn: () => 80,
    }),
    setSelection(range) {
      const anchor = range.selectionStartLineNumber === undefined ?
        {lineNumber: range.startLineNumber, column: range.startColumn} :
        {lineNumber: range.selectionStartLineNumber, column: range.selectionStartColumn};
      const active = range.positionLineNumber === undefined ?
        {lineNumber: range.endLineNumber, column: range.endColumn} :
        {lineNumber: range.positionLineNumber, column: range.positionColumn};
      const ordered = [anchor, active].sort((a, b) => a.lineNumber - b.lineNumber || a.column - b.column);
      selection = {
        getStartPosition: () => ordered[0], getEndPosition: () => ordered[1],
        isEmpty: () => anchor.lineNumber === active.lineNumber && anchor.column === active.column,
        containsPosition: position =>
          (position.lineNumber > ordered[0].lineNumber ||
            (position.lineNumber === ordered[0].lineNumber && position.column >= ordered[0].column)) &&
          (position.lineNumber < ordered[1].lineNumber ||
            (position.lineNumber === ordered[1].lineNumber && position.column <= ordered[1].column)),
      };
      emit("onDidChangeCursorSelection");
    },
    getScrolledVisiblePosition: position => ({
      left: 40 + (position.column - 1) * 8 - scrollLeft,
      top: (position.lineNumber - 1) * 20 - scrollTop, height: 20,
    }),
    addContentWidget(widget) {
      widgets.add(widget);
      widget.node.getBoundingClientRect = () => {
        const position = editor.getScrolledVisiblePosition(widget.getPosition().position);
        return {...position, width: 2, bottom: position.top + position.height};
      };
    },
    removeContentWidget: widget => widgets.delete(widget),
    layoutContentWidget(widget) { widget.position = widget.getPosition(); },
    getLayoutInfo: () => layout,
    getScrollTop: () => scrollTop,
    getScrollLeft: () => scrollLeft,
    setScrollPosition(position) {
      scrollTop = Math.max(0, Math.min(3800, position.scrollTop));
      scrollLeft = Math.max(0, Math.min(240, position.scrollLeft));
      emit("onDidScrollChange");
    },
    getTargetAtClientPoint(x, y) {
      if (x >= 386 || y >= 190) return {position: null}; // Scrollbars are not text.
      for (const widget of widgets) {
        if (!widget.getPosition() || widget.handle.style.pointerEvents === "none") continue;
        const rect = widget.node.getBoundingClientRect();
        if (x >= rect.left - 9 && x <= rect.left + 11 && y >= rect.bottom - 1 && y <= rect.bottom + 19) {
          return {position: null};
        }
      }
      return {position: {
        lineNumber: Math.floor((y + scrollTop) / 20) + 1,
        column: Math.round((x - 40 + scrollLeft) / 8) + 1,
      }};
    },
    focus() {},
    render() {},
    updateOptions: next => Object.assign(options, next),
  };
  for (const name of ["onDidChangeCursorSelection", "onDidScrollChange", "onDidLayoutChange", "onContextMenu"]) {
    const listeners = new Set();
    events.set(name, listeners);
    editor[name] = callback => {
      listeners.add(callback);
      return {dispose: () => listeners.delete(callback)};
    };
  }
  editor.setSelection({startLineNumber: 2, startColumn: 4, endLineNumber: 2, endColumn: 4});
  const touch = new TouchSelection(editor, 0);
  const selected = () => [selection.getStartPosition(), selection.getEndPosition()];
  return {editor, node, nodes, touch, frames, events, widgets, selected, options,
    contextMenu: () => emit("onContextMenu", {
      target: {position: {lineNumber: 2, column: 4}}, event: {preventDefault() {}},
    }),
    resize(contentWidth) {
      layout.contentWidth = contentWidth;
      emit("onDidLayoutChange");
    },
    frame() {
      const callbacks = Array.from(frames.values());
      frames.clear();
      callbacks.forEach(callback => callback());
    },
    start(side) {
      const widget = Array.from(widgets).find(widget => widget.side === side);
      const rect = widget.node.getBoundingClientRect();
      widget.handle.send("pointerdown", {clientX: rect.left + 8, clientY: rect.top + 30});
      return widget.handle;
    },
    move(handle, lineNumber, column) {
      const position = editor.getScrolledVisiblePosition({lineNumber, column});
      handle.send("pointermove", {clientX: position.left + 8, clientY: position.top + 30});
    },
  };
}

function touchSelectsWordsAndBothEndsCanCross() {
  const state = fixture(false);
  state.contextMenu();
  assert.equal(state.editor.getSelection().isEmpty(), true);
  state.node.send("pointerdown");
  assert.equal(state.options.contextmenu, false);
  state.node.send("pointerdown", {clientX: 399, clientY: 10});
  assert.equal(state.options.contextmenu, true);
  state.node.send("pointerdown");
  state.contextMenu();
  assert.deepEqual(state.selected(), [{lineNumber: 2, column: 1}, {lineNumber: 2, column: 10}]);
  state.node.send("pointerdown", {clientX: 64, clientY: 30});
  assert.equal(state.options.contextmenu, true);
  const end = state.start("end");
  state.move(end, 3, 10);
  assert.deepEqual(state.selected(), [{lineNumber: 2, column: 1}, {lineNumber: 3, column: 10}]);
  end.send("pointercancel", {pointerId: 2});
  assert.equal(end.captures.size, 1);
  state.move(end, 5, 14);
  assert.deepEqual(state.selected(), [{lineNumber: 2, column: 1}, {lineNumber: 5, column: 14}]);
  end.send("pointercancel");
  assert.equal(state.frames.size, 0);
  assert.equal(end.captures.size, 0);
  assert.equal(end.style.pointerEvents, "");
  const start = state.start("start");
  state.move(start, 7, 5);
  assert.deepEqual(state.selected(), [{lineNumber: 5, column: 14}, {lineNumber: 7, column: 5}]);
  start.send("lostpointercapture");
  const other = state.start("end");
  state.move(other, 3, 4);
  assert.deepEqual(state.selected(), [{lineNumber: 3, column: 4}, {lineNumber: 5, column: 14}]);
  other.send("pointercancel");
  state.contextMenu();
  assert.deepEqual(state.selected(), [{lineNumber: 3, column: 4}, {lineNumber: 5, column: 14}]);
  state.node.send("pointerdown", {pointerType: "mouse"});
  assert.equal(state.options.contextmenu, true);
  assert.ok(Array.from(state.widgets).every(widget => widget.getPosition() === null));
  state.touch.dispose();
}

function draggingScrollsAndDisposalReleasesEverything() {
  const state = fixture();
  state.contextMenu();
  const end = state.start("end");
  const event = end.send("pointermove", {clientX: 88, clientY: 260});
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  const firstScroll = state.editor.getScrollTop();
  state.frame();
  state.frame();
  assert.ok(state.editor.getScrollTop() > firstScroll);
  assert.ok(state.selected()[1].lineNumber > 10);
  const independent = fixture();
  state.touch.dispose();
  assert.equal(state.widgets.size, 0);
  assert.equal(state.frames.size, 0);
  assert.ok(state.nodes.every(node => node.captures.size === 0));
  assert.ok(state.nodes.every(node => Array.from(node.listeners.values()).every(set => set.size === 0)));
  assert.ok(Array.from(state.events.values()).every(set => set.size === 0));
  assert.equal(independent.widgets.size, 2);
  independent.touch.dispose();
}

function hiddenDiffSidePreservesSelectionWithoutHandles() {
  const state = fixture();
  state.contextMenu();
  const selected = state.selected();
  assert.ok(Array.from(state.widgets).every(widget => widget.position));
  state.resize(-10);
  assert.ok(Array.from(state.widgets).every(widget => widget.position === null));
  state.resize(360);
  assert.ok(Array.from(state.widgets).every(widget => widget.position));
  assert.deepEqual(state.selected(), selected);
  state.touch.dispose();
}

touchSelectsWordsAndBothEndsCanCross();
draggingScrollsAndDisposalReleasesEverything();
hiddenDiffSidePreservesSelectionWithoutHandles();
