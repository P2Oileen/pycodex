// Reference implementation: displays only readable recorded reasoning.
export function mount(host) {
  const root = document.createElement("details");
  root.hidden = true;
  root.className = "example-reasoning-display";
  const heading = document.createElement("summary");
  heading.textContent = "Recorded reasoning";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const list = document.createElement("div");
  list.className = "example-reasoning-list";
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
        const page = await host.request(
          `api/sessions/${encodeURIComponent(sessionId)}/history?limit=200`,
          {signal: request.signal},
        );
        if (request.signal.aborted || host.getActiveSessionId() !== sessionId) return;
        const rows = page.items
          .filter(item => item.type === "response_item" && item.payload.type === "reasoning")
          .map(item => ({
            index: item.index,
            summary: (item.payload.summary || [])
              .filter(part => part.type === "summary_text").map(part => part.text).join("\n"),
            text: (item.payload.content || [])
              .filter(part => part.type === "reasoning_text").map(part => part.text).join("\n"),
          }))
          .filter(row => row.summary.trim() || row.text.trim());
        root.hidden = rows.length === 0;
        status.textContent = `${rows.length} readable reasoning records in the latest ${page.items.length} history records.`;
        if (page.next_cursor !== null) status.textContent += " Older records are not shown.";
        const serialized = JSON.stringify(rows);
        if (serialized !== lastRows) {
          list.replaceChildren(...rows.slice().reverse().map(row => {
            const section = document.createElement("section");
            const title = document.createElement("strong");
            title.textContent = `History record ${row.index}`;
            section.append(title);
            for (const [label, value] of [["Summary", row.summary], ["Text", row.text]]) {
              if (!value.trim()) continue;
              const name = document.createElement("p");
              name.textContent = label;
              const text = document.createElement("pre");
              text.textContent = value;
              section.append(name, text);
            }
            return section;
          }));
          lastRows = serialized;
        }
      } catch (error) {
        if (request.signal.aborted) return;
        list.replaceChildren();
        lastRows = "";
        status.textContent = `Unable to read recorded reasoning: ${error.message}`;
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
