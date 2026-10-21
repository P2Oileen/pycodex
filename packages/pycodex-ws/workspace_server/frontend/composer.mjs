/** A plain-text editor whose context tokens occupy one cursor position each. */
export class Composer {
  constructor(element, changed, submit, editContext, error, recallInput = null) {
    this.element = element;
    this.changed = changed;
    this.submit = submit;
    this.editContext = editContext;
    this.error = error;
    this.recallInput = recallInput;
    this.recalledParts = null;
    this.composing = false;
    this.selection = { start: 0, end: 0 };
    this.undo = [];
    this.redo = [];
    this.previous = this.read();
    element.addEventListener("input", event => {
      if (!event.isComposing) this.record();
      this.changed();
    });
    element.addEventListener("compositionstart", () => { this.composing = true; });
    element.addEventListener("compositionend", () => {
      this.composing = false;
      this.record();
      this.changed();
    });
    document.addEventListener("selectionchange", () => {
      if (this.captureSelection()) this.changed();
    });
    element.addEventListener("keydown", event => this.keydown(event));
    element.addEventListener("beforeinput", event => {
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault();
        this.history(event.inputType === "historyUndo");
      } else if (event.inputType.startsWith("format")) event.preventDefault();
    });
    element.addEventListener("click", event => {
      const token = event.target.closest(".context-token");
      if (token) this.editContext(JSON.parse(token.dataset.context));
    });
    element.addEventListener("mousedown", event => {
      if (event.target.closest(".context-token")) event.preventDefault();
    });
    element.addEventListener("copy", event => this.copy(event, false));
    element.addEventListener("cut", event => this.copy(event, true));
    element.addEventListener("paste", event => {
      event.preventDefault();
      this.paste(event.clipboardData);
    });
    element.addEventListener("dragover", event => event.preventDefault());
    element.addEventListener("drop", event => {
      event.preventDefault();
      const range = document.caretRangeFromPoint(event.clientX, event.clientY);
      if (range && element.contains(range.startContainer)) {
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        this.captureSelection();
      }
      this.paste(event.dataTransfer);
    });
  }

  static size(parts) {
    return parts.reduce((size, part) => size + (part.type === "context" ? 1 : part.text.length), 0);
  }

  static text(parts) { return parts.map(part => part.text).join(""); }

  static slice(parts, start, end) {
    const result = [];
    let offset = 0;
    for (const part of parts) {
      const size = Composer.size([part]);
      if (start < offset + size && end > offset) {
        result.push(part.type === "context" ? { ...part } : {
          type: "text", text: part.text.slice(Math.max(0, start - offset), end - offset),
        });
      }
      offset += size;
    }
    return result;
  }

  parts(root = this.element) {
    const result = [];
    const text = value => {
      if (!value) return;
      const last = result.at(-1);
      if (last?.type === "text") last.text += value;
      else result.push({ type: "text", text: value });
    };
    const visit = parent => {
      for (const node of parent.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) text(node.data);
        else if (node.dataset?.context) result.push(JSON.parse(node.dataset.context));
        else if (node.nodeName === "BR") {
          if (!node.hasAttribute("data-tail") && parent.childNodes.length > 1) text("\n");
        } else {
          if (["DIV", "P"].includes(node.nodeName) && result.length &&
              !result.at(-1).text.endsWith("\n")) text("\n");
          visit(node);
        }
      }
    };
    visit(root);
    return result;
  }

  captureSelection() {
    if (document.activeElement !== this.element) return false;
    const selection = window.getSelection();
    if (!selection.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (!this.element.contains(range.startContainer) || !this.element.contains(range.endContainer)) return false;
    const prefix = document.createRange();
    prefix.selectNodeContents(this.element);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = Composer.size(this.parts(prefix.cloneContents()));
    this.selection = { start, end: start + Composer.size(this.parts(range.cloneContents())) };
    return true;
  }

  read() {
    this.captureSelection();
    return { parts: this.parts(), selection: { ...this.selection } };
  }

  set(value) {
    this.recalledParts = null;
    this.undo = [];
    this.redo = [];
    this.render(value);
    if (document.activeElement === this.element) this.focus();
    this.previous = this.read();
  }

  render(value) {
    const parts = value.parts || [];
    this.element.replaceChildren();
    for (const part of parts) {
      if (part.type === "text") this.element.append(document.createTextNode(part.text));
      else {
        const token = document.createElement("span");
        token.className = "context-token";
        token.contentEditable = "false";
        token.dataset.context = JSON.stringify(part);
        token.textContent = part.label;
        token.title = part.label + "\nClick to edit context; Backspace / Delete to remove";
        this.element.append(token, document.createTextNode(""));
      }
    }
    if (!parts.length || (parts.at(-1).type === "text" && parts.at(-1).text.endsWith("\n"))) {
      const tail = document.createElement("br");
      tail.dataset.tail = "";
      this.element.append(tail);
    }
    const size = Composer.size(parts);
    this.selection = value.selection || { start: size, end: size };
    this.selection = {
      start: Math.min(this.selection.start, size), end: Math.min(this.selection.end, size),
    };
    this.element.classList.toggle("empty", !parts.length);
  }

  focus() {
    this.element.focus({ preventScroll: true });
    const point = offset => {
      const walk = parent => {
        for (let index = 0; index < parent.childNodes.length; index++) {
          const node = parent.childNodes[index];
          if (node.nodeType === Node.TEXT_NODE) {
            if (offset <= node.length) return [node, offset];
            offset -= node.length;
          } else if (node.dataset?.context) {
            if (offset === 0) return [parent, index];
            offset -= 1;
            if (offset === 0) return [parent, index + 1];
          } else if (node.nodeName === "BR") {
            if (offset === 0) return [parent, index];
            if (!node.hasAttribute("data-tail")) offset -= 1;
          } else {
            const found = walk(node);
            if (found) return found;
          }
        }
      };
      return walk(this.element) || [this.element, this.element.childNodes.length];
    };
    const range = document.createRange();
    range.setStart(...point(this.selection.start));
    range.setEnd(...point(this.selection.end));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  record() {
    const current = this.read();
    if (JSON.stringify(current.parts) !== JSON.stringify(this.previous.parts)) {
      this.undo.push(this.previous);
      if (this.undo.length > 40) this.undo.shift();
      this.redo = [];
      this.previous = current;
    }
    this.element.classList.toggle("empty", !current.parts.length);
  }

  replace(start, end, inserted) {
    const current = this.read();
    const parts = [
      ...Composer.slice(current.parts, 0, start), ...inserted,
      ...Composer.slice(current.parts, end, Composer.size(current.parts)),
    ];
    const cursor = start + Composer.size(inserted);
    this.render({ parts, selection: { start: cursor, end: cursor } });
    this.focus();
    this.record();
    this.changed();
  }

  insert(blocks) {
    this.captureSelection();
    this.replace(this.selection.start, this.selection.end,
      blocks.map(block => ({
        ...block, type: "context", id: crypto.getRandomValues(new Uint32Array(4)).join("-"),
      })));
  }

  updateContext(id, text) {
    for (const token of this.element.querySelectorAll(".context-token")) {
      const block = JSON.parse(token.dataset.context);
      if (block.id === id) token.dataset.context = JSON.stringify({ ...block, text });
    }
    this.record();
    this.changed();
  }

  removeContext(id) {
    let offset = 0;
    for (const part of this.parts()) {
      if (part.type === "context" && part.id === id) {
        this.replace(offset, offset + 1, []);
        return;
      }
      offset += Composer.size([part]);
    }
  }

  history(back) {
    const from = back ? this.undo : this.redo;
    if (!from.length) return;
    (back ? this.redo : this.undo).push(this.read());
    this.render(from.pop());
    this.focus();
    this.previous = this.read();
    this.changed();
  }

  keydown(event) {
    if (event.isComposing || this.composing || event.keyCode === 229) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (this.recallInput && ["ArrowUp", "ArrowDown"].includes(event.key) &&
        !modifier && !event.altKey && !event.shiftKey) {
      const current = this.read();
      if (current.selection.start === current.selection.end) {
        const offset = current.selection.start;
        const text = Composer.text(current.parts);
        // Keep vertical cursor movement inside multiline drafts.
        const back = event.key === "ArrowUp";
        const prefix = Composer.text(Composer.slice(current.parts, 0, offset));
        const suffix = Composer.text(Composer.slice(current.parts, offset, Composer.size(current.parts)));
        const browsing = this.recalledParts === JSON.stringify(current.parts);
        if (browsing || !text || !(back ? prefix : suffix).includes("\n")) {
          const recalled = this.recallInput(back, current);
          if (recalled) {
            event.preventDefault();
            this.render(recalled);
            this.recalledParts = JSON.stringify(recalled.parts);
            this.focus();
            this.record();
            this.changed();
          }
        }
      }
    } else if (modifier && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
      event.preventDefault();
      this.history(event.key.toLowerCase() === "z" && !event.shiftKey);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        this.captureSelection();
        this.replace(this.selection.start, this.selection.end, [{ type: "text", text: "\n" }]);
      } else this.submit();
    } else if (["Backspace", "Delete"].includes(event.key) && !modifier && !event.altKey) {
      this.captureSelection();
      const { start, end } = this.selection;
      const left = event.key === "Backspace" ? start - 1 : start;
      if (start === end && Composer.slice(this.parts(), left, left + 1)[0]?.type === "context") {
        event.preventDefault();
        this.replace(left, left + 1, []);
      }
    }
  }

  copy(event, cut) {
    if (!this.captureSelection() || this.selection.start === this.selection.end) return;
    const parts = Composer.slice(this.parts(), this.selection.start, this.selection.end);
    event.clipboardData.setData("text/plain", Composer.text(parts));
    event.clipboardData.setData("application/x-pycodex-parts", JSON.stringify(parts));
    event.preventDefault();
    if (cut) this.replace(this.selection.start, this.selection.end, []);
  }

  paste(data) {
    try {
      const custom = data.getData("application/x-pycodex-parts");
      const parts = custom ? JSON.parse(custom) : [{ type: "text", text: data.getData("text/plain") }];
      if (!Array.isArray(parts) || parts.some(part => !part || typeof part.text !== "string" ||
          !["text", "context"].includes(part.type) ||
          (part.type === "context" && typeof part.label !== "string"))) {
        throw new Error("Invalid context format in clipboard.");
      }
      this.captureSelection();
      this.replace(this.selection.start, this.selection.end, parts.map(part =>
        part.type === "context" ? {
          ...part, id: crypto.getRandomValues(new Uint32Array(4)).join("-"),
        } : part));
    } catch (error) {
      this.error(error.message);
    }
  }
}
