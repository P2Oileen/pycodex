// Reference controller. The caller supplies existing session snapshots.
export function createSessionTips(chat, toolbar) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "session-tips-toggle";
  button.hidden = true;
  button.setAttribute("aria-label", "Tips · Private notes");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9Z"/>
    <path d="M15 3v6h6M7 13h10M7 17h6"/></svg>`;
  const panel = document.createElement("details");
  panel.className = "session-tips";
  panel.hidden = true;
  panel.innerHTML = `<summary aria-label="Close private notes">
    <span class="session-tips-label">Tips</span><span>Private notes</span>
    <span class="session-tips-close" aria-hidden="true">⌃</span></summary>
    <div class="session-tips-body">
      <textarea class="session-tips-editor" aria-label="Private notes for this conversation"
        placeholder="Things to remember for this conversation…" spellcheck="false"></textarea>
      <div class="session-tips-footer"><span>This browser only · Not sent to the model</span>
        <span class="session-tips-status" role="status"></span></div>
    </div>`;
  chat.append(panel);
  toolbar.append(button);
  const editor = panel.querySelector("textarea");
  const status = panel.querySelector(".session-tips-status");
  const prefix = "pycodex.workspace.sessionTips:v1:" + location.pathname + ":";
  const openKey = prefix + "open";
  const states = new Map();
  const records = new Map();
  const lifetime = new AbortController();
  let current = null;
  let isOpen = false;
  let hasOpenPreference = false;
  let disposed = false;
  try {
    const stored = localStorage.getItem(openKey);
    if (stored === "true" || stored === "false") {
      isOpen = stored === "true";
      hasOpenPreference = true;
    }
  } catch (_) {}

  function read(key) {
    if (records.has(key)) return records.get(key);
    let state;
    try {
      const record = JSON.parse(localStorage.getItem(key) || "null");
      state = {key, text: typeof record?.text === "string" ? record.text : "",
        legacyOpen: record?.open === true, saved: true, ready: false,
        exists: typeof record?.text === "string"};
    } catch (_) {
      state = {key, text: "", legacyOpen: false, saved: false, ready: false, exists: false};
    }
    records.set(key, state);
    return state;
  }

  function renderStatus() {
    button.setAttribute("aria-expanded", String(isOpen));
    button.dataset.hasNote = String(Boolean(current.text.trim()));
    button.title = "Tips · Private notes" +
      (current.text.trim() ? "\n" + current.text.split("\n").find(line => line.trim()).trim() : "");
    status.textContent = !current.ready ? "Loading…" :
      current.saved ? (current.text ? "Saved" : "Autosave") : "Not saved · Kept on this page";
    status.dataset.unsaved = String(!current.saved);
  }

  function save(state = current) {
    state.exists = true;
    try {
      localStorage.setItem(state.key, JSON.stringify({text: state.text}));
      state.saved = true;
    } catch (_) { state.saved = false; }
    if (current === state) renderStatus();
  }

  function select(sessionId, snapshot = null) {
    if (disposed) return;
    panel.hidden = button.hidden = !sessionId;
    if (!sessionId) {current = null; return;}
    let state = states.get(sessionId);
    if (!state) {
      let boundKey = null;
      try {boundKey = localStorage.getItem(prefix + "binding:" + sessionId);} catch (_) {}
      if (!boundKey?.startsWith(prefix + "rollout:")) boundKey = null;
      state = read(boundKey || prefix + "session:" + sessionId);
      state.ready = Boolean(boundKey);
      states.set(sessionId, state);
    }
    const rollout = snapshot && snapshot.rollout_path;
    if (typeof rollout === "string" && rollout) {
      const key = prefix + "rollout:" + rollout;
      if (state.key !== key) {
        const stored = read(key);
        if (state.key.startsWith(prefix + "session:") && !stored.exists && state.exists) {
          stored.text = state.text;
          stored.legacyOpen = state.legacyOpen;
          save(stored);
        }
        state = stored;
        states.set(sessionId, state);
      }
      try {localStorage.setItem(prefix + "binding:" + sessionId, key);} catch (_) {}
    }
    if (snapshot) state.ready = true;
    if (current !== state) editor.value = state.text;
    current = state;
    panel.dataset.sessionId = sessionId;
    if (!hasOpenPreference && current.ready) setOpen(current.legacyOpen);
    panel.open = isOpen;
    editor.disabled = !current.ready;
    renderStatus();
  }

  function setOpen(open, focusButton = false) {
    if (!current) return;
    isOpen = open;
    hasOpenPreference = true;
    panel.open = open;
    try {localStorage.setItem(openKey, String(open));} catch (_) {}
    renderStatus();
    if (focusButton) button.focus();
  }

  editor.addEventListener("input", () => {
    if (!current || !current.ready) return;
    current.text = editor.value;
    save(); // Synchronous save: no pending debounce during navigation.
  }, {signal: lifetime.signal});
  button.addEventListener("click", () => {
    setOpen(!isOpen);
    if (isOpen && current?.ready) editor.focus();
  }, {signal: lifetime.signal});
  panel.querySelector("summary").addEventListener("click", event => {
    event.preventDefault();
    setOpen(false, true);
  }, {signal: lifetime.signal});
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && isOpen &&
        (panel.contains(event.target) || button.contains(event.target))) {
      event.preventDefault();
      setOpen(false, true);
    }
  }, {signal: lifetime.signal});
  return {
    select,
    loadError(message) {
      if (disposed || !current) return;
      status.textContent = "Unable to load session: " + message;
      status.dataset.unsaved = "true";
    },
    dispose() {
      disposed = true;
      lifetime.abort();
      panel.remove();
      button.remove();
      states.clear();
      records.clear();
      current = null;
    },
  };
}
