export function createHost() {
  const listeners = new Set();
  const host = {
    selected: "a",
    requests: [],
    reply: null,
    getActiveSessionId() { return host.selected; },
    async selectSession(id) {
      host.selected = id;
      listeners.forEach(listener => listener(id));
    },
    onSessionChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get listenerCount() { return listeners.size; },
    async request(path, options = {}) {
      host.requests.push({path, method: options.method || "GET"});
      if (host.reply) return host.reply(path, options);
      const id = new URL(path, location.href).searchParams.get("session_id");
      return {snapshot: {rollout_path: `/demo/session-${id}.jsonl`}};
    },
  };
  return host;
}
