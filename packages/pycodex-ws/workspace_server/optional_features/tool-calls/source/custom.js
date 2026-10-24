// Reference implementation: adapt this source into your own custom.js.
export function mount(host) {
  const root = document.createElement("details");
  root.hidden = true;
  root.className = "example-tool-calls";
  const heading = document.createElement("summary");
  heading.textContent = "Tool calls";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const list = document.createElement("div");
  list.className = "example-tool-calls-list";
  root.append(heading, status, list);
  document.querySelector(".composer").prepend(root);
  const lifetime = new AbortController();
  let stopSession = () => {};

  function select() {
    stopSession();
    root.hidden = true;
    list.replaceChildren();
    const sessionId = host.getActiveSessionId();
    status.textContent = "";
    if (!sessionId) return;
    const request = new AbortController();
    let timer;
    let lastRows = "";
    stopSession = () => {
      request.abort();
      clearTimeout(timer);
    };
    async function refresh() {
      try {
        // A fresh newest page avoids keeping invalid cursors after fork/compact.
        const page = await host.request(
          `api/sessions/${encodeURIComponent(sessionId)}/history?limit=200`,
          {signal: request.signal},
        );
        if (request.signal.aborted || host.getActiveSessionId() !== sessionId) return;
        const calls = new Map();
        for (const record of page.items) {
          if (record.type !== "response_item") continue;
          const item = record.payload;
          if (item.type === "function_call" || item.type === "custom_tool_call") {
            calls.set(item.call_id, {
              id: item.call_id, name: item.name,
              input: item.type === "function_call" ? item.arguments : item.input,
              output: undefined,
            });
          } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
            const call = calls.get(item.call_id) || {
              id: item.call_id, name: item.name || "Earlier tool call",
              input: undefined,
            };
            call.output = item.output;
            calls.set(item.call_id, call);
          }
        }
        root.hidden = calls.size === 0;
        status.textContent = `${calls.size} calls in the latest ${page.items.length} history records` +
          (page.next_cursor === null ? "." : " · older records are not shown.");
        const rows = Array.from(calls.values());
        const serialized = JSON.stringify(rows);
        if (serialized !== lastRows) {
          const expanded = new Set(Array.from(list.children)
            .filter(node => node.open).map(node => node.dataset.callId));
          list.replaceChildren(...rows.reverse().map(call => {
            const detail = document.createElement("details");
            detail.dataset.callId = call.id;
            detail.open = expanded.has(call.id);
            const summary = document.createElement("summary");
            summary.textContent = `${call.name} · ${call.output === undefined ? "no recorded result in this page" : "result recorded"}`;
            const identity = document.createElement("p");
            identity.textContent = `Call: ${call.id}`;
            detail.append(summary, identity);
            for (const [label, value] of [["Input", call.input], ["Output", call.output]]) {
              const title = document.createElement("strong");
              title.textContent = label;
              const text = document.createElement("pre");
              text.textContent = value === undefined ? "Not present in this history page."
                : typeof value === "string" ? value : JSON.stringify(value, null, 2);
              detail.append(title, text);
            }
            return detail;
          }));
          lastRows = serialized;
        }
      } catch (error) {
        if (request.signal.aborted) return;
        list.replaceChildren();
        lastRows = "";
        status.textContent = `Unable to read tool history: ${error.message}`;
        root.hidden = false;
      } finally {
        if (!request.signal.aborted) timer = setTimeout(refresh, 2000);
      }
    }
    refresh();
  }

  const unsubscribe = host.onSessionChanged(select);
  window.addEventListener("pagehide", () => stopSession(), {signal: lifetime.signal});
  window.addEventListener("pageshow", event => {
    if (event.persisted) select();
  }, {signal: lifetime.signal});
  select();
  return () => {
    stopSession();
    unsubscribe();
    lifetime.abort();
    root.remove();
  };
}
