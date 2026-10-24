// Reference implementation: adapt this source into your own custom.js.
export function mount(host) {
  const root = document.createElement("section");
  root.className = "example-exec-status";
  root.setAttribute("aria-label", "Command sessions");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const list = document.createElement("ul");
  root.append(status, list);
  document.querySelector(".composer").prepend(root);
  const lifetime = new AbortController();
  let stopSession = () => {};

  function select() {
    stopSession();
    list.replaceChildren();
    const sessionId = host.getActiveSessionId();
    status.textContent = sessionId ? "Loading command sessions…" : "Select a session.";
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
        const {background_work} = await host.request(
          `api/sessions/${encodeURIComponent(sessionId)}/background-work`,
          {signal: request.signal},
        );
        if (request.signal.aborted || host.getActiveSessionId() !== sessionId) return;
        const commands = background_work.filter(item => item.kind === "exec");
        status.textContent = commands.length
          ? `${commands.filter(item => item.status === "running").length} running · ${commands.length} command sessions`
          : "No command sessions.";
        const serialized = JSON.stringify(commands);
        if (serialized !== lastRows) {
          list.replaceChildren(...commands.map(command => {
            const item = document.createElement("li");
            item.dataset.status = command.status;
            item.textContent = `#${command.session_id} · PID ${command.pid} · ${command.tty ? "PTY" : "pipes"} · ` +
              (command.status === "exited" ? `exited (${command.exit_code})` : command.status);
            return item;
          }));
          lastRows = serialized;
        }
      } catch (error) {
        if (request.signal.aborted) return;
        list.replaceChildren();
        lastRows = "";
        status.textContent = `Unable to read command sessions: ${error.message}`;
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
