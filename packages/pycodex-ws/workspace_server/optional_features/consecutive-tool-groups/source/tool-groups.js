// Reference source: call update() with the current tools for one conversation group.
export function createToolGroup(container, {sessionId, groupId}) {
  const key = `pycodex:tool-groups:v1:${location.pathname}:${sessionId}:${groupId}`;
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(key) || "{}") || {}; } catch (_) {}
  const expanded = new Set(Array.isArray(saved.calls) ? saved.calls : []);
  const root = node("details", "tool-group");
  root.hidden = true;
  root.open = saved.open === true;
  const heading = node("summary");
  const count = node("span", "tool-group-count");
  const running = node("span", "tool-group-running");
  const errors = node("span", "tool-group-errors");
  heading.append(count, running, errors);
  const list = node("div", "tool-group-list");
  root.append(heading, list);
  container.append(root);
  const rows = new Map();
  let disposed = false;

  function save() {
    for (const [id, row] of rows) {
      if (row.open) expanded.add(id);
      else expanded.delete(id);
    }
    try {
      sessionStorage.setItem(key, JSON.stringify({open: root.open, calls: [...expanded]}));
    } catch (_) {
      // Storage may be disabled or full; the current DOM remains usable.
    }
  }

  function toggled(event) {
    const row = event.target;
    if (disposed) return;
    if (row !== root) {
      if (rows.get(row.dataset.callId) !== row) return;
      if (row.open) expanded.add(row.dataset.callId);
      else expanded.delete(row.dataset.callId);
    }
    save();
  }
  root.addEventListener("toggle", toggled, true);
  window.addEventListener("pagehide", save);

  return {
    update(calls) {
      if (disposed) return;
      root.hidden = calls.length === 0;
      count.textContent = `Tool calls · ${calls.length}`;
      const runningCount = calls.filter(call => call.status === "running").length;
      const errorCount = calls.filter(call => call.status === "error").length;
      running.textContent = runningCount ? `${runningCount} running` : "";
      errors.textContent = errorCount ? `${errorCount} failed` : "";
      const retained = new Set(calls.map(call => call.call_id));
      for (const [id, row] of rows) {
        if (!retained.has(id)) { row.remove(); rows.delete(id); }
      }
      for (const id of expanded) {
        if (!retained.has(id)) expanded.delete(id);
      }
      calls.forEach((call, index) => {
        let row = rows.get(call.call_id);
        if (!row) {
          row = node("details", "tool-group-call");
          row.dataset.callId = call.call_id;
          row.open = expanded.has(call.call_id);
          row.append(node("summary"), node("p", "tool-group-id"));
          for (const label of ["Input", "Output"]) {
            row.append(node("strong", "", label), node("pre"));
          }
          rows.set(call.call_id, row);
        }
        const status = call.status === "running" ? "running"
          : call.status === "error" ? "failed"
          : call.output !== undefined ? "result recorded" : "result not recorded";
        row.querySelector("summary").textContent = `${call.name} · ${status}`;
        row.querySelector("summary").classList.toggle("tool-group-errors", call.status === "error");
        row.querySelector(".tool-group-id").textContent = `Call: ${call.call_id}`;
        const sections = row.querySelectorAll("pre");
        sections[0].textContent = text(call.arguments === undefined ? call.input : call.arguments);
        sections[1].textContent = text(call.output);
        if (list.children[index] !== row) {
          list.insertBefore(row, list.children[index] || null);
        }
      });
      save();
    },
    dispose() {
      if (disposed) return;
      save();
      disposed = true;
      root.removeEventListener("toggle", toggled, true);
      window.removeEventListener("pagehide", save);
      root.remove();
      rows.clear();
    },
  };
}

function node(tag, className = "", content = "") {
  const result = document.createElement(tag);
  result.className = className;
  result.textContent = content;
  return result;
}

function text(value) {
  return value === undefined ? "Not present in the supplied records."
    : typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
