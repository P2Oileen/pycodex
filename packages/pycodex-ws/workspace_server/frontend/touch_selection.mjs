// Touch selection uses Monaco ranges, including text outside the rendered viewport.
export class TouchSelection {
  constructor(editor, exactPosition) {
    this.editor = editor;
    this.node = editor.getDomNode();
    this.document = this.node.ownerDocument;
    this.window = this.document.defaultView;
    this.touch = this.window.matchMedia("(pointer: coarse)").matches;
    this.disposables = [];
    this.drag = null;
    this.frame = null;
    this.widgets = ["start", "end"].map(side => {
      const node = this.document.createElement("div");
      node.className = "editor-selection-boundary";
      const handle = this.document.createElement("button");
      handle.type = "button";
      handle.className = "editor-selection-handle";
      handle.tabIndex = -1;
      handle.setAttribute("aria-label", "Selection " + side);
      node.appendChild(handle);
      const widget = {
        side, node, handle, suppressMouseDown: true, allowEditorOverflow: true,
        getId: () => "pycodex.selection." + side,
        getDomNode: () => node,
        getPosition: () => {
          const selection = editor.getSelection();
          // An inline diff keeps the original gutter but gives its text no width.
          if (!this.touch || selection.isEmpty() || editor.getLayoutInfo().contentWidth <= 0) return null;
          return {
            position: side === "start" ? selection.getStartPosition() : selection.getEndPosition(),
            preference: [exactPosition],
          };
        },
      };
      this.listen(handle, "pointerdown", event => this.startDrag(event, widget));
      this.listen(handle, "pointermove", event => this.moveDrag(event));
      this.listen(handle, "pointerup", event => {
        this.moveDrag(event);
        this.stopDrag(event);
      });
      this.listen(handle, "pointercancel", event => this.stopDrag(event));
      this.listen(handle, "lostpointercapture", event => this.stopDrag(event));
      this.listen(handle, "contextmenu", event => event.preventDefault());
      editor.addContentWidget(widget);
      return widget;
    });
    this.listen(this.node, "pointerdown", event => {
      this.touch = event.pointerType === "touch" || event.pointerType === "pen";
      const selection = editor.getSelection();
      const target = editor.getTargetAtClientPoint(event.clientX, event.clientY);
      // First select with accessible handles; pressing the selection opens its menu.
      editor.updateOptions({contextmenu: !this.touch || !target || !target.position ||
        (!selection.isEmpty() && selection.containsPosition(target.position))});
      this.layout();
    }, true);
    this.disposables.push(
      editor.onDidChangeCursorSelection(() => this.layout()),
      editor.onDidScrollChange(() => this.layout()),
      editor.onDidLayoutChange(() => this.layout()),
      editor.onContextMenu(event => {
        if (!this.touch || !event.target.position || !editor.getSelection().isEmpty()) return;
        event.event.preventDefault();
        const position = event.target.position;
        const model = editor.getModel();
        const word = model.getWordAtPosition(position);
        editor.setSelection({
          startLineNumber: position.lineNumber,
          startColumn: word ? word.startColumn : position.column,
          endLineNumber: position.lineNumber,
          endColumn: word ? word.endColumn :
            Math.min(position.column + 1, model.getLineMaxColumn(position.lineNumber)),
        });
      }),
    );
    this.layout();
  }

  listen(node, type, callback, options) {
    node.addEventListener(type, callback, options);
    this.disposables.push({dispose: () => node.removeEventListener(type, callback, options)});
  }

  layout() {
    for (const widget of this.widgets) {
      const position = widget.getPosition();
      if (position) {
        const visible = this.editor.getScrolledVisiblePosition(position.position);
        if (visible) widget.node.style.height = visible.height + "px";
      }
      this.editor.layoutContentWidget(widget);
    }
  }

  startDrag(event, widget) {
    event.preventDefault();
    event.stopPropagation();
    if (this.drag) return;
    this.touch = true;
    const selection = this.editor.getSelection();
    const rect = widget.node.getBoundingClientRect();
    this.drag = {
      handle: widget.handle, pointerId: event.pointerId,
      anchor: widget.side === "start" ? selection.getEndPosition() : selection.getStartPosition(),
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top - rect.height / 2,
      x: rect.left, y: rect.top + rect.height / 2,
    };
    widget.handle.setPointerCapture(event.pointerId);
    this.editor.focus();
    this.frame = this.window.requestAnimationFrame(() => this.animateDrag());
  }

  moveDrag(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    this.drag.x = event.clientX - this.drag.offsetX;
    this.drag.y = event.clientY - this.drag.offsetY;
    this.updateDrag();
  }

  animateDrag() {
    this.frame = null;
    if (!this.drag) return;
    this.updateDrag();
    this.frame = this.window.requestAnimationFrame(() => this.animateDrag());
  }

  updateDrag() {
    const {x, y, anchor} = this.drag;
    const rect = this.node.getBoundingClientRect();
    const layout = this.editor.getLayoutInfo();
    const left = rect.left + layout.contentLeft;
    const right = left + layout.contentWidth - layout.verticalScrollbarWidth;
    const bottom = rect.bottom - layout.horizontalScrollbarHeight;
    const step = (value, low, high) => Math.max(-16, Math.min(16,
      value < low ? value - low : value > high ? value - high : 0));
    const scrollTop = this.editor.getScrollTop();
    const scrollLeft = this.editor.getScrollLeft();
    this.editor.setScrollPosition({
      scrollTop: scrollTop + step(y, rect.top + 40, bottom - 40),
      scrollLeft: scrollLeft + step(x, left + 20, right - 20),
    });
    if (scrollTop !== this.editor.getScrollTop() || scrollLeft !== this.editor.getScrollLeft()) {
      this.editor.render();
    }
    // Exclude the handles only while locating the text beneath them.
    this.widgets.forEach(widget => { widget.handle.style.pointerEvents = "none"; });
    let target;
    try {
      target = this.editor.getTargetAtClientPoint(
        Math.max(left + 1, Math.min(right - 1, x)),
        Math.max(rect.top + 1, Math.min(bottom - 1, y)),
      );
    } finally {
      this.widgets.forEach(widget => { widget.handle.style.pointerEvents = ""; });
    }
    if (!target || !target.position) return;
    this.editor.setSelection({
      selectionStartLineNumber: anchor.lineNumber,
      selectionStartColumn: anchor.column,
      positionLineNumber: target.position.lineNumber,
      positionColumn: target.position.column,
    });
  }

  stopDrag(event) {
    const drag = this.drag;
    if (event && drag && event.pointerId !== drag.pointerId) return;
    this.drag = null;
    if (this.frame !== null) this.window.cancelAnimationFrame(this.frame);
    this.frame = null;
    if (drag && drag.handle.hasPointerCapture(drag.pointerId)) {
      drag.handle.releasePointerCapture(drag.pointerId);
    }
  }

  dispose() {
    this.stopDrag();
    this.disposables.forEach(disposable => disposable.dispose());
    this.widgets.forEach(widget => this.editor.removeContentWidget(widget));
  }
}
