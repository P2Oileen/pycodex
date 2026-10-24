// Browser-only checks used by preview.html?verify; no backend or model calls.
export async function verify(mount, sample, empty, check) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const composer = document.querySelector(".composer");
  const draft = composer.querySelector("textarea");
  const listeners = new Set();
  const pending = [];
  let sessionId = "";
  let automatic = false;
  let requests = 0;
  const host = {
    getActiveSessionId: () => sessionId,
    onSessionChanged: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    request: (path, options) => {
      assert(path.startsWith(`api/sessions/${encodeURIComponent(sessionId)}/`), "Incorrect session path");
      requests++;
      if (automatic) return Promise.resolve(sample());
      return new Promise((resolve, reject) => pending.push({resolve, reject, signal: options.signal}));
    },
  };
  const select = id => { sessionId = id; listeners.forEach(callback => callback(id)); };
  const cleanup = mount(host);
  const root = composer.firstElementChild;
  assert(root.getClientRects().length === 0, "Empty selection occupied space");
  select("first/session");
  assert(root.getClientRects().length === 0, "Initial loading occupied space");
  const first = pending.shift();
  select("second/session");
  const second = pending.shift();
  assert(first.signal.aborted, "Old request not aborted");
  second.resolve(sample());
  await pause(0);
  check(root);
  const older = empty();
  first.resolve(older); // Deliberately ignore abort to emulate a late transport.
  await pause(0);
  check(root);
  await pause(2100);
  pending.shift().resolve(empty());
  await pause(0);
  assert(root.getClientRects().length === 0, "Cleared inventory occupied space");
  await pause(2100);
  pending.shift().resolve(sample());
  await pause(0);
  check(root);
  select("");
  assert(root.getClientRects().length === 0, "Deselection left visible UI");
  select("offline");
  assert(root.getClientRects().length === 0, "Session switch left visible UI");
  pending.shift().reject(new Error("fixture offline"));
  await pause(0);
  assert(root.getClientRects().length > 0 && root.textContent.includes("fixture offline"), "Failure not visible");
  await pause(2100);
  assert(pending.length === 1, "Polling did not retry");
  pending.shift().resolve(empty());
  await pause(0);
  assert(root.getClientRects().length === 0, "Empty recovery left visible error UI");
  select("hidden");
  const hidden = pending.shift();
  window.dispatchEvent(new Event("pagehide"));
  assert(hidden.signal.aborted, "Page hide did not abort");
  const count = requests;
  hidden.resolve(older);
  await pause(2100);
  assert(requests === count, "Hidden page kept polling");
  window.dispatchEvent(new PageTransitionEvent("pageshow", {persisted: true}));
  pending.shift().resolve(sample());
  await pause(0);
  check(root);
  cleanup();
  assert(listeners.size === 0 && !root.isConnected, "Cleanup leaked UI/subscription");
  window.dispatchEvent(new PageTransitionEvent("pageshow", {persisted: true}));
  assert(pending.length === 0, "Cleanup leaked page listener");
  assert(draft.value === "My existing draft", "Composer draft was changed");
  automatic = true;
  mount(host);
  await pause(0);
  check(composer.firstElementChild);
}
