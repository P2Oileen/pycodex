import {createSessionTips} from "./session-tips.js";
const check = (condition, message) => {if (!condition) throw new Error(message);};

export async function verify() {
  const scope = "pycodex.workspace.sessionTips:v1:" + location.pathname + ":";
  const oldOpen = localStorage.getItem(scope + "open");
  const id = "verification-" + Date.now();
  const root = document.createElement("section");
  const toolbar = document.createElement("div");
  root.append(toolbar);
  document.body.append(root);
  localStorage.removeItem(scope + "open");
  let tips = createSessionTips(root, toolbar);
  let panel = root.querySelector(".session-tips");
  let editor = panel.querySelector("textarea");
  const edit = text => {editor.value = text; editor.dispatchEvent(new Event("input"));};
  const select = (session, rollout = "") => tips.select(session, {rollout_path: rollout});
  const setItem = Storage.prototype.setItem;
  try {
    tips.select("");
    check(panel.hidden, "No selected session hides notes");
    tips.select(id + "-a");
    check(editor.disabled, "Unresolved identity disables editing");
    select(id + "-a", "/demo/" + id + "-a");
    check(!editor.disabled && !panel.open, "First note starts collapsed");
    toolbar.querySelector("button").click();
    check(panel.open, "Button opens note");
    edit("Private note α\n<img src=x onerror=alert(1)>");
    select(id + "-b", "/demo/" + id + "-b");
    check(editor.value === "" && panel.open, "New session has independent text and shared visibility");
    edit("Other note");
    select(id + "-a", "/demo/" + id + "-a");
    check(editor.value.startsWith("Private note α\n"), "Returning session retains note");
    check(!panel.querySelector("img"), "Note remains plain textarea text");
    panel.querySelector("summary").click();
    select(id + "-b", "/demo/" + id + "-b");
    check(!panel.open && editor.value === "Other note", "Closed preference also spans sessions");
    tips.dispose();
    tips = createSessionTips(root, toolbar);
    panel = root.querySelector(".session-tips");
    editor = panel.querySelector("textarea");
    select(id + "-restored", "/demo/" + id + "-a");
    check(editor.value.startsWith("Private note α\n") && !panel.open, "New tab ID restores rollout note");
    select(id + "-draft");
    edit("Before first recorded message");
    select(id + "-draft", "/demo/" + id + "-recorded");
    select(id + "-another-id", "/demo/" + id + "-recorded");
    check(editor.value === "Before first recorded message", "Pre-rollout note migrates");
    select(id + "-failed-write");
    Storage.prototype.setItem = () => {throw new DOMException("quota");};
    edit("Preserve unsaved text");
    check(panel.querySelector("[data-unsaved='true']"), "Storage failure is visible");
    select(id + "-failed-write", "/demo/" + id + "-unsaved");
    select(id + "-away");
    select(id + "-failed-write", "/demo/" + id + "-unsaved");
    check(editor.value === "Preserve unsaved text", "Unsaved migration and session switch retain text");
    tips.dispose();
    tips.select(id + "-late", {});
    check(!root.querySelector(".session-tips") && !toolbar.children.length, "Disposed controller cannot reappear");
  } finally {
    Storage.prototype.setItem = setItem;
    tips.dispose();
    root.remove();
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key.startsWith(scope) && key.includes(id)) localStorage.removeItem(key);
    }
    if (oldOpen === null) localStorage.removeItem(scope + "open");
    else localStorage.setItem(scope + "open", oldOpen);
  }
}
