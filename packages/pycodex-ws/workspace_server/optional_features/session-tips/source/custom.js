import {createSessionTips} from "./session-tips.js";

// Adapt into the existing mount(host), preserving unrelated customizations.
export function mount(host) {
  const chat = document.querySelector(".chat");
  const toolbar = chat.querySelector(".tabbar");
  const tips = createSessionTips(chat, toolbar);
  const lifetime = new AbortController();
  let stopSession = () => {};
  function select() {
    stopSession();
    const id = host.getActiveSessionId();
    tips.select(id);
    if (!id) return;
    const request = new AbortController();
    let timer;
    stopSession = () => {
      request.abort();
      clearTimeout(timer);
    };
    async function refresh() {
      try {
        const data = await host.request(`api/session?session_id=${encodeURIComponent(id)}`,
          {signal: request.signal});
        if (request.signal.aborted || host.getActiveSessionId() !== id) return;
        tips.select(id, data.snapshot);
      } catch (error) {
        if (!request.signal.aborted && host.getActiveSessionId() === id) {
          tips.loadError(error.message);
        }
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
    tips.dispose();
  };
}
