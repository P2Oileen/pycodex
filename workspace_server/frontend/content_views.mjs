// Workspace content tabs, live updates and editor lifecycle.
export function isWorkspaceLink(href, filePaths = true) {
  if (typeof href !== "string" || !href || href !== href.trim() || /[\x00-\x1f\x7f]/.test(href)) {
    return false;
  }
  if (/^(?:diff:|git:|workspace:\/\/canvas\/?$)/i.test(href)) return true;
  if (!filePaths || /^(?:https?|ftps?|mailto|tel|sms|javascript|vbscript|data|blob|about|file):/i.test(href)) {
    return false;
  }
  const parts = href.split("#");
  if (parts.length > 2 || (parts.length === 2 && !/^L-?\d+$/i.test(parts[1]))) return false;
  const path = parts[0].replace(/:-?\d+$/, "");
  return !!path && !path.startsWith("//") && !path.includes("?") &&
    (!/^[a-z][a-z\d+.-]*:/i.test(path) || /^[a-z]:(?:[/\\]|%2f|%5c)/i.test(path));
}

export class ContentTabs {
  constructor({request, onChange, onSelect, selected = null}) {
    this.request = request;
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.views = [];
    this.activeId = "board";
    this.snapshot = null;
    this.selection = null;
    this.displayMode = null;
    this.loading = false;
    this.error = "";
    this.closing = new Set();
    this.cache = new Map();
    this.initialSelection = selected;
    this.initialized = false;
    this.mutation = 0;
    this.pollRequest = null;
    this.contentRequest = null;
    this.openRequest = null;
    this.timer = null;
  }

  start() {
    if (this.timer !== null) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), 2000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.cancelOpen();
    if (this.pollRequest) this.pollRequest.abort();
    if (this.contentRequest) this.contentRequest.abort();
    this.pollRequest = null;
    this.contentRequest = null;
    this.loading = false;
  }

  async poll() {
    if (this.pollRequest || this.openRequest) return;
    const request = new AbortController();
    const mutation = this.mutation;
    this.pollRequest = request;
    try {
      const payload = await this.request("api/views", {signal: request.signal});
      if (this.pollRequest !== request || mutation !== this.mutation) return;
      this.updateViews(payload.views);
      const remaining = new Set(this.views.map(view => view.id));
      this.error = "";
      let next = this.activeId;
      if (!this.initialized) {
        next = this.initialSelection || "board";
        this.initialized = true;
      }
      if (next !== "board" && !remaining.has(next)) next = "board";
      if (next !== this.activeId || (!this.snapshot && next !== "board" && !this.loading)) {
        this.select(next);
      } else {
        if (next !== "board" && !this.cache.has(next) && !this.contentRequest) this.load(next);
        this.onChange(this);
      }
    } catch (error) {
      if (this.pollRequest === request && mutation === this.mutation && error.name !== "AbortError") {
        this.error = "Unable to load tabs: " + error.message;
        this.onChange(this);
      }
    } finally {
      if (this.pollRequest === request) this.pollRequest = null;
    }
  }

  updateViews(views) {
    this.views = views;
    const revisions = new Map(views.map(view => [view.id, view.revision]));
    for (const [id, snapshot] of this.cache) {
      if (!revisions.has(id) || snapshot.revision < revisions.get(id)) this.cache.delete(id);
    }
  }

  cancelOpen() {
    if (this.openRequest) this.openRequest.abort();
    this.openRequest = null;
  }

  async open(href) {
    this.cancelOpen();
    if (/^workspace:\/\/canvas\/?$/i.test(href)) {
      await this.select("board");
      return;
    }
    const request = new AbortController();
    this.openRequest = request;
    this.mutation += 1;
    this.error = "";
    this.onChange(this);
    try {
      const payload = await this.request("api/views/open", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({href}),
        signal: request.signal,
      });
      if (this.openRequest !== request) return;
      this.mutation += 1;
      this.updateViews(payload.views);
      const view = payload.view;
      this.cache.set(view.id, view);
      this.initialized = true;
      this.openRequest = null;
      return this.select(view.id, view.selection ? {
        ...view.selection, revision: view.reveal_revision, contentRevision: view.revision,
      } : null, view.selection ? "source" : "preview");
    } catch (error) {
      if (this.openRequest !== request || error.name === "AbortError") return;
      this.error = "Unable to open view: " + error.message;
      throw error;
    } finally {
      if (this.openRequest === request) {
        this.openRequest = null;
        this.onChange(this);
      }
    }
  }

  async select(id, selection = null, displayMode = null) {
    if (id !== "board" && !this.views.some(view => view.id === id)) return;
    this.cancelOpen();
    const current = id === this.activeId ? this.snapshot : null;
    if (this.contentRequest) this.contentRequest.abort();
    this.contentRequest = null;
    this.activeId = id;
    this.selection = selection;
    this.displayMode = displayMode;
    if (!this.initialized) this.initialSelection = id;
    this.snapshot = this.cache.get(id) || current;
    this.loading = id !== "board" && !this.snapshot;
    this.error = "";
    this.onSelect(id);
    this.onChange(this);
    if (id === "board" || this.cache.has(id)) return;
    await this.load(id);
  }

  async load(id) {
    const request = new AbortController();
    this.contentRequest = request;
    try {
      const snapshot = await this.request("api/views/" + encodeURIComponent(id), {
        signal: request.signal,
      });
      if (this.contentRequest !== request || this.activeId !== id) return;
      const view = this.views.find(view => view.id === id);
      if (!view || snapshot.revision < view.revision) return;
      this.cache.set(id, snapshot);
      this.snapshot = snapshot;
      this.error = "";
    } catch (error) {
      if (this.contentRequest !== request || this.activeId !== id || error.name === "AbortError") return;
      this.error = "Unable to load view: " + error.message;
    } finally {
      if (this.contentRequest === request) {
        this.contentRequest = null;
        this.loading = false;
        this.onChange(this);
      }
    }
  }

  async close(id) {
    if (id === "board" || this.closing.has(id)) return;
    this.cancelOpen();
    this.closing.add(id);
    this.mutation += 1;
    this.onChange(this);
    try {
      await this.request("api/views/" + encodeURIComponent(id), {method: "DELETE"});
      this.mutation += 1;
      const index = this.views.findIndex(view => view.id === id);
      this.views = this.views.filter(view => view.id !== id);
      this.cache.delete(id);
      if (this.activeId === id) {
        await this.select(index > 0 ? this.views[index - 1].id : "board");
      }
    } catch (error) {
      this.error = "Unable to close tab: " + error.message;
    } finally {
      this.closing.delete(id);
      this.onChange(this);
    }
  }
}

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tabLabels(views) {
  function directory(path) {
    const separator = path.lastIndexOf("/");
    return separator < 0 ? "." : path.slice(0, separator) || "/";
  }

  const pathsByName = new Map();
  const entries = views.map(view => {
    const labels = view.kind === "diff" ? view.title.split(" <-> ") : [view.title];
    const sources = labels.map(label => {
      // Canonical Git labels are SHA:path or reference (SHA):path.
      const git = /^(?:([0-9a-f]{40}|[0-9a-f]{64})|.+ \(([0-9a-f]{40}|[0-9a-f]{64})\)):(.+)$/i.exec(label);
      const path = git ? git[3] : label;
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (!pathsByName.has(name)) pathsByName.set(name, new Set());
      pathsByName.get(name).add(path);
      return {path, name, revision: git ? (git[1] || git[2]).slice(0, 7) : null};
    });
    return {view, sources};
  });

  const directories = new Map();
  for (const paths of pathsByName.values()) {
    if (paths.size < 2) continue;
    const names = Array.from(paths);
    const parts = names.map(path => directory(path).split("/"));
    names.forEach((path, index) => {
      let length = 1;
      while (length < parts[index].length && parts.some((other, otherIndex) =>
        otherIndex !== index &&
        other.slice(-length).join("/") === parts[index].slice(-length).join("/"))) length += 1;
      directories.set(path, parts[index].slice(-length).join("/") || "/");
    });
  }

  return new Map(entries.map(({view, sources}) => {
    const samePath = sources.every(source => source.path === sources[0].path);
    const name = samePath ? sources[0].name : sources.map(source => source.name).join(" ↔ ");
    let location = "";
    if (samePath) {
      location = directories.get(sources[0].path) || "";
    } else if (sources.some(source => directories.has(source.path))) {
      location = sources.map(source => directories.get(source.path) || directory(source.path)).join(" ↔ ");
    }
    const versions = sources.some(source => source.revision) ?
      sources.map(source => source.revision || "working tree").join(" ↔ ") :
      view.kind === "diff" && samePath ? "diff" : "";
    return [view.id, {name, description: [location, versions].filter(Boolean).join(" · ")}];
  }));
}

class HtmlPreview {
  constructor(parent, position = [0, 0]) {
    this.document = parent.ownerDocument;
    this.window = this.document.defaultView;
    this.position = position;
    this.generation = 0;
    this.frame = element(this.document, "iframe", "snapshot-html");
    this.frame.title = "HTML preview";
    this.receive = event => {
      if (event.source !== this.frame.contentWindow) return;
      const message = event.data;
      if (!message || message.generation !== this.generation) return;
      if (message.type === "workspace-preview-ready") {
        this.frame.contentWindow.postMessage({
          type: "workspace-preview-restore", generation: this.generation,
          position: this.position,
        }, "*");
      } else if (message.type === "workspace-preview-scroll" &&
          Array.isArray(message.position) && message.position.length === 2 &&
          message.position.every(Number.isFinite)) {
        this.position = message.position;
      }
    };
    this.window.addEventListener("message", this.receive);
    parent.appendChild(this.frame);
  }

  update(source) {
    if (source === this.source) return;
    const page = new this.window.DOMParser().parseFromString(source, "text/html");
    const generation = this.generation + 1;
    const script = page.createElement("script");
    // Like Canvas, this is a same-origin page; the bridge preserves scrolling.
    script.textContent = `(() => {
      const generation = ${generation};
      let restored = false;
      function report() {
        if (restored) parent.postMessage({
          type: "workspace-preview-scroll", generation, position: [scrollX, scrollY],
        }, "*");
      }
      addEventListener("message", event => {
        const message = event.data;
        if (event.source !== parent || !message ||
            message.type !== "workspace-preview-restore" || message.generation !== generation) return;
        scrollTo(message.position[0], message.position[1]);
        restored = true;
        report();
      });
      addEventListener("scroll", report, {passive: true});
      addEventListener("load", () => parent.postMessage({
        type: "workspace-preview-ready", generation,
      }, "*"));
    })();`;
    page.head.prepend(script);
    const doctype = page.doctype ?
      new this.window.XMLSerializer().serializeToString(page.doctype) + "\n" : "";
    this.frame.srcdoc = doctype + page.documentElement.outerHTML;
    this.generation = generation;
    this.source = source;
  }

  capture() { return this.position; }

  destroy() {
    this.window.removeEventListener("message", this.receive);
  }
}

export class SnapshotDisplay {
  constructor({content, renderMarkdown, loadEditor = null,
    createHtmlPreview = (parent, position) => new HtmlPreview(parent, position)}) {
    this.content = content;
    this.document = content.ownerDocument;
    this.renderMarkdown = renderMarkdown;
    this.loadEditor = loadEditor || (() => this.loadEditorAssets());
    this.editorAssets = null;
    this.createHtmlPreview = createHtmlPreview;
    this.activeId = null;
    this.editor = null;
    this.htmlPreview = null;
    this.generation = 0;
    this.remaining = new Set();
    this.editorStates = new Map();
    this.previews = new Map();
    this.scrollPositions = new Map();
    this.sourceViews = new Set();
    this.pendingSelection = null;
    this.selectionRevision = 0;
  }

  loadEditorAssets() {
    if (!this.editorAssets) {
      const stylesheet = this.document.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href = new URL("./editor.css", import.meta.url).href;
      const styles = new Promise((resolve, reject) => {
        stylesheet.addEventListener("load", resolve, {once: true});
        stylesheet.addEventListener("error",
          () => reject(new Error("Editor stylesheet request failed.")), {once: true});
      });
      this.document.head.appendChild(stylesheet);
      this.editorAssets = Promise.all([import("./editor.mjs"), styles])
        .then(([module]) => module)
        .catch(error => {
          stylesheet.remove();
          this.editorAssets = null;
          throw error;
        });
    }
    return this.editorAssets;
  }

  retain(ids) {
    this.remaining = new Set(ids);
    for (const cache of [this.editorStates, this.previews, this.scrollPositions, this.sourceViews]) {
      for (const id of cache.keys()) {
        if (!this.remaining.has(id)) cache.delete(id);
      }
    }
  }

  clear(message = "") {
    this.generation += 1;
    if (this.editor) {
      if (this.remaining.has(this.activeId)) {
        this.editorStates.set(this.activeId, this.editor.capture());
      }
      this.editor.destroy();
      this.editor = null;
    } else if (this.htmlPreview) {
      if (this.remaining.has(this.activeId)) {
        this.scrollPositions.set(this.activeId, this.htmlPreview.capture());
      }
      this.htmlPreview.destroy();
      this.htmlPreview = null;
    } else if (this.remaining.has(this.activeId) && this.previews.has(this.activeId)) {
      this.scrollPositions.set(this.activeId, [this.content.scrollLeft, this.content.scrollTop]);
    }
    this.activeId = null;
    this.content.classList.remove("code-view");
    this.content.classList.remove("html-view");
    this.content.textContent = "";
    if (message) {
      this.content.appendChild(element(this.document, "div", "content-placeholder", message));
    }
  }

  async show(id, snapshot, selection = null, displayMode = null) {
    if (selection && snapshot.revision < selection.contentRevision) selection = null;
    this.pendingSelection = selection;
    if (displayMode === "preview") this.sourceViews.delete(id);
    else if (selection || displayMode === "source") this.sourceViews.add(id);
    const source = snapshot.documents[0];
    const markup = snapshot.kind === "file" && !this.sourceViews.has(id);
    const markdown = markup && /\.(md|markdown)$/i.test(source.label) && this.renderMarkdown;
    const html = markup && /\.html?$/i.test(source.label);
    if (this.activeId === id && this.htmlPreview && html) {
      return this.htmlPreview.update(source.text);
    }
    if (this.activeId === id && this.editor && !markdown && !html) {
      const generation = this.generation;
      try {
        await this.editor.update(snapshot);
        if (generation === this.generation) await this.applySelection(id, selection);
      } catch (error) {
        if (generation === this.generation) throw error;
      }
      return;
    }
    this.clear();
    this.activeId = id;
    const generation = this.generation;
    if (snapshot.kind === "diff" || (!source.image_url && !markdown && !html)) {
      this.content.classList.add("code-view");
      this.content.appendChild(element(this.document, "div", "content-placeholder", "Loading code viewer…"));
      try {
        const module = await this.loadEditor();
        if (generation !== this.generation) return;
        this.content.textContent = "";
        const parent = element(this.document, "div", "workspace-editor");
        this.content.appendChild(parent);
        const editor = await module.createSnapshotEditor(parent, snapshot, this.editorStates.get(id));
        if (generation !== this.generation) {
          editor.destroy();
          return;
        }
        this.editor = editor;
      } catch (error) {
        if (generation !== this.generation) return;
        this.content.textContent = "";
        this.content.appendChild(element(this.document, "div", "content-placeholder",
          "Unable to load code viewer: " + error.message));
        return;
      }
      await this.applySelection(id, selection);
      return;
    }
    if (html) {
      this.content.classList.add("html-view");
      this.htmlPreview = this.createHtmlPreview(
        this.content, this.scrollPositions.get(id)
      );
      return this.htmlPreview.update(source.text);
    }
    if (!this.previews.has(id)) {
      const root = element(this.document, "div", "snapshot");
      const heading = element(this.document, "div", "snapshot-heading");
      heading.appendChild(element(this.document, "span", "snapshot-label", source.label));
      heading.appendChild(element(this.document, "span", "snapshot-stamp", "Read only"));
      root.appendChild(heading);
      if (source.image_url) {
        const image = element(this.document, "img", "snapshot-image");
        image.alt = source.label;
        root.appendChild(image);
      } else {
        root.appendChild(element(this.document, "div", "snapshot-markdown markdown"));
      }
      this.previews.set(id, root);
    }
    this.content.appendChild(this.previews.get(id));
    const image = this.content.querySelector(".snapshot-image");
    if (image && image.src !== source.image_url) image.src = source.image_url;
    if (markdown) {
      this.renderMarkdown(this.content.querySelector(".snapshot-markdown"), source.text);
    }
    const [left, top] = this.scrollPositions.get(id) || [0, 0];
    this.content.scrollLeft = left;
    this.content.scrollTop = top;
  }

  async applySelection(id, selection) {
    if (!selection || selection.revision <= this.selectionRevision) return;
    const editor = this.editor;
    const isCurrent = () => this.activeId === id && this.editor === editor &&
      this.pendingSelection === selection && selection.revision > this.selectionRevision;
    if (!isCurrent()) return;
    if (await editor.revealLine(selection.document, selection.line, isCurrent)) {
      this.selectionRevision = selection.revision;
    }
  }
}

export function mountContentViews({tabs, frame, content, status, request, storage, storageKey, renderMarkdown}) {
  const document = tabs.ownerDocument;
  const display = new SnapshotDisplay({content, renderMarkdown});
  let displayedId = "board";
  let displayedSnapshot = null;
  let displayedLoading = false;
  let displayedSelection = null;
  let displayedMode = null;
  let controller;

  function focusTab(id) {
    const tab = document.getElementById("content-tab-" + id);
    if (tab) {
      tab.focus({preventScroll: true});
      tab.scrollIntoView({block: "nearest", inline: "nearest"});
    }
  }

  function render(state) {
    const errors = state.snapshot ? state.snapshot.documents.map(source => source.error) : [];
    status.textContent = [state.error, ...errors].filter(Boolean).join("; ") ||
      (state.openRequest ? "Opening view…" : "");
    status.title = status.textContent;
    status.hidden = !status.textContent;
    const existing = new Map(Array.from(tabs.children, tab => [tab.dataset.viewId, tab]));
    const descriptors = [{id: "board", title: "Canvas", kind: "board"}].concat(state.views);
    const labels = tabLabels(state.views);
    labels.set("board", {name: "Canvas", description: ""});
    descriptors.forEach((view, index) => {
      let tab = existing.get(view.id);
      if (!tab) {
        tab = element(document, "div", "tab content-tab");
        tab.dataset.viewId = view.id;
        tab.id = "content-tab-" + view.id;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-controls", view.id === "board" ? frame.id : content.id);
        const label = element(document, "span", "tab-label content-tab-label");
        label.appendChild(element(document, "span", "content-tab-name"));
        label.appendChild(element(document, "span", "content-tab-description"));
        tab.appendChild(label);
        tab.addEventListener("click", () => controller.select(view.id));
        tab.addEventListener("keydown", event => {
          if (event.target !== tab) return;
          const order = ["board"].concat(controller.views.map(item => item.id));
          const current = order.indexOf(view.id);
          let target = null;
          if (event.key === "ArrowRight") target = order[(current + 1) % order.length];
          if (event.key === "ArrowLeft") target = order[(current + order.length - 1) % order.length];
          if (event.key === "Home") target = order[0];
          if (event.key === "End") target = order[order.length - 1];
          if (event.key === "Enter" || event.key === " ") target = view.id;
          if (event.key === "Delete" && view.id !== "board") {
            event.preventDefault();
            controller.close(view.id);
          }
          if (target !== null) {
            event.preventDefault();
            controller.select(target);
            document.getElementById("content-tab-" + target).focus();
          }
        });
        if (view.id !== "board") {
          const close = element(document, "button", "tab-close content-tab-close");
          close.type = "button";
          close.title = "Close tab";
          close.setAttribute("aria-label", "Close " + view.title);
          close.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
            'stroke-width="1.5" stroke-linecap="round" aria-hidden="true">' +
            '<path d="M4 4l8 8M12 4l-8 8"/></svg>';
          close.addEventListener("click", event => {
            event.stopPropagation();
            controller.close(view.id);
          });
          tab.appendChild(close);
        }
      }
      existing.delete(view.id);
      const label = labels.get(view.id);
      tab.querySelector(".content-tab-name").textContent = label.name;
      const description = tab.querySelector(".content-tab-description");
      description.textContent = label.description;
      description.hidden = !label.description;
      tab.className = "tab content-tab" + (view.id === state.activeId ? " active" : "");
      tab.tabIndex = view.id === state.activeId ? 0 : -1;
      tab.title = view.id === "board" ? tabs.dataset.boardTitle :
        view.title + (view.live ? "\nRead only · follows file changes · " : "\nRead-only snapshot · ") +
        new Date(view.created_at).toLocaleString();
      tab.setAttribute("aria-selected", String(view.id === state.activeId));
      tab.setAttribute("aria-label", view.title);
      const close = tab.querySelector(".content-tab-close");
      if (close) {
        close.disabled = state.closing.has(view.id);
        close.setAttribute("aria-label", "Close " + view.title);
      }
      if (tabs.children[index] !== tab) tabs.insertBefore(tab, tabs.children[index] || null);
    });
    existing.forEach(tab => tab.remove());
    display.retain(state.views.map(view => view.id));
    const isBoard = state.activeId === "board";
    const switched = displayedId !== state.activeId;
    const changed = switched || displayedSnapshot !== state.snapshot ||
      displayedLoading !== state.loading || displayedSelection !== state.selection ||
      displayedMode !== state.displayMode;
    // Hidden elements report zero scroll offsets, so capture before hiding.
    if (isBoard && changed) display.clear();
    frame.hidden = !isBoard;
    content.hidden = isBoard;
    if (!changed) return;
    displayedId = state.activeId;
    displayedSnapshot = state.snapshot;
    displayedLoading = state.loading;
    displayedSelection = state.selection;
    displayedMode = state.displayMode;
    content.setAttribute("aria-labelledby", "content-tab-" + state.activeId);
    content.setAttribute("aria-busy", String(state.loading));
    if (isBoard) return;
    if (state.snapshot) {
      const id = state.activeId;
      const snapshot = state.snapshot;
      display.show(id, snapshot, state.selection, state.displayMode).catch(error => {
        if (displayedId !== id || displayedSnapshot !== snapshot) return;
        displayedSnapshot = null;
        state.error = "Unable to update view: " + error.message;
        status.textContent = status.title = state.error;
        status.hidden = false;
      });
    } else {
      display.clear(state.loading ? "Loading view…" : "View unavailable.");
    }
    if (switched) focusTab(state.activeId);
  }

  controller = new ContentTabs({
    request,
    onChange: render,
    onSelect: id => {
      storage.setItem(storageKey, id);
      content.closest(".workspace").dataset.mobilePane = "board";
      focusTab(id);
    },
    selected: storage.getItem(storageKey),
  });
  render(controller);
  return {
    start() {
      controller.start();
      render(controller);
    },
    stop() {
      controller.stop();
      display.clear();
      displayedId = null;
    },
    poll() { return controller.poll(); },
    open(href) { return controller.open(href); },
  };
}
