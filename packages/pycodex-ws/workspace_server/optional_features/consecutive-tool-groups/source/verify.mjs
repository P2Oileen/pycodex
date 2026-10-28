import {createToolGroup} from "./tool-groups.js";
import {sample} from "./fixture.mjs";

const check = (condition, message) => { if (!condition) throw new Error(message); };
const settled = () => new Promise(resolve => setTimeout(resolve, 30));

export async function verify() {
  const host = document.createElement("div");
  document.body.append(host);
  const sessionId = `verification-${Date.now()}`;
  const options = {sessionId, groupId: "turn"};
  let controller = createToolGroup(host, options);
  try {
    controller.update([]);
    check(host.firstElementChild.hidden, "Empty group should not occupy space");
    controller.update(sample());
    let root = host.firstElementChild;
    check(!root.open && !root.hidden, "New groups start collapsed");
    check(root.querySelectorAll("[data-call-id]").length === 3, "One group retains all calls");
    check(root.querySelector(".tool-group-running").textContent === "1 running", "Running count");
    check(root.querySelector(".tool-group-errors").textContent === "1 failed", "Failed count");
    root.open = true;
    const row = root.querySelector('[data-call-id="tests"]');
    row.open = true;
    await settled();
    const calls = sample();
    calls[2] = {...calls[2], status: "completed", output: "<img src=x onerror=alert(1)>".repeat(500)};
    controller.update(calls);
    check(root.open && row.open, "Live update preserves open state");
    check(row === root.querySelector('[data-call-id="tests"]'), "Live update retains the call DOM");
    check(root.querySelector(".tool-group-running").textContent === "", "Finished calls stop counting as running");
    check(!root.querySelector("img"), "Tool output must be literal text");
    const output = row.querySelectorAll("pre")[1];
    check(output.textContent.includes("<img"), "Original output retained");
    check(output.clientHeight <= 280 && output.scrollHeight > output.clientHeight, "Bounded output scroll");
    controller.dispose();
    check(!host.children.length, "Dispose removes group");
    controller = createToolGroup(host, options);
    controller.update(calls);
    root = host.firstElementChild;
    check(root.open && root.querySelector('[data-call-id="tests"]').open, "Remount restores expansion");
    controller.dispose();
    controller = createToolGroup(host, {sessionId: sessionId + "-other", groupId: "turn"});
    controller.update(sample());
    check(!host.firstElementChild.open, "Another session starts collapsed");
    controller.update(sample().slice(0, 1));
    check(host.querySelectorAll("[data-call-id]").length === 1, "Removed calls leave no stale rows");
    controller.update([]);
    check(host.firstElementChild.hidden, "Empty updates hide group");
    controller.dispose();
    controller.update(sample());
    check(!host.children.length, "Late updates cannot revive disposed groups");
  } finally {
    controller.dispose();
    host.remove();
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key.includes(sessionId)) sessionStorage.removeItem(key);
    }
  }
}
