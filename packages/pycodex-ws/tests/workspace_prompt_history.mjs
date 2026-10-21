import assert from "node:assert/strict";
import {PromptHistory} from "../workspace_server/frontend/prompt_history.mjs";
import {Composer} from "../workspace_server/frontend/composer.mjs";

const draft = text => ({parts: [{type: "text", text}], selection: {start: 0, end: 0}});
const turn = (id, prompt, sender = "web", kind = "assistant") => ({
  submission_id: id, prompt, sender, kind,
});
const clock = '<clock_tick>\n{"period_m":5.0,"current_time":"2026-10-21T15:06:26+08:00"}\n</clock_tick>';

const history = new PromptHistory();
history.update([
  turn("1", "first command"), turn("2", clock),
  turn("3", '<exec_command_completed>\n{"session_id":12}\n</exec_command_completed>', "resume"),
  turn("4", "second command", "resume"), turn("5", "Context compacted", "web", "compaction"),
  turn("6", "framework input", "system"), turn("7", "", "web", "control"),
]);
const unsent = draft("unsent draft");
let current = history.recall(true, unsent);
assert.equal(Composer.text(current.parts), "second command");
current = history.recall(true, current);
assert.equal(Composer.text(current.parts), "first command");
assert.equal(history.recall(true, current), null);
current = history.recall(false, current);
assert.equal(Composer.text(current.parts), "second command");
assert.deepEqual(history.recall(false, current), unsent);
assert.equal(history.recall(false, unsent), null);
history.update([turn("4", "second command", "resume"), turn("8", clock)]);
assert.equal(history.entries.length, 2);

const context = {type: "context", text: "source text", label: "app.py:12", id: "ctx"};
const rich = {parts: [{type: "text", text: "check this\n"}, context]};
history.remember(rich);
history.update([turn("9", Composer.text(rich.parts))]);
assert.equal(history.entries.length, 3);
current = history.recall(true, unsent);
assert.deepEqual(current.parts, rich.parts);
context.text = "changed externally";
assert.equal(current.parts[1].text, "source text");
history.reset();
history.remember(draft(clock)); // Explicit user input is retained even when it resembles an event.
history.update([turn("10", clock)]);
assert.equal(Composer.text(history.recall(true, unsent).parts), clock);
assert.equal(history.entries.length, 4);

const separate = new PromptHistory();
assert.equal(separate.recall(true, unsent), null);
for (let i = 0; i < 105; i++) separate.remember(draft(String(i)));
assert.equal(separate.entries.length, 100);
current = separate.recall(true, unsent);
assert.equal(Composer.text(current.parts), "104");
current = separate.recall(true, draft("edited recall"));
assert.equal(Composer.text(current.parts), "104");
assert.deepEqual(separate.recall(false, current), draft("edited recall"));

// Exercise keyboard decisions without a DOM; browser checks cover real selections.
function keyboardFixture(value) {
  const input = new PromptHistory();
  input.remember(draft("old\nmultiline"));
  input.remember(draft("latest\nmultiline"));
  const composer = Object.create(Composer.prototype);
  composer.recallInput = (back, current) => input.recall(back, current);
  composer.read = () => value;
  composer.render = recalled => {
    value = recalled;
    value.selection ||= {start: Composer.size(value.parts), end: Composer.size(value.parts)};
  };
  composer.focus = composer.record = composer.changed = () => {};
  return {
    value: () => value,
    press: (key, options = {}) => {
      let prevented = false;
      composer.keydown({key, ...options, preventDefault: () => { prevented = true; }});
      return prevented;
    },
  };
}
const keyboard = keyboardFixture(draft(""));
assert.equal(keyboard.press("ArrowUp"), true);
assert.equal(Composer.text(keyboard.value().parts), "latest\nmultiline");
assert.equal(keyboard.press("ArrowUp"), true);
assert.equal(Composer.text(keyboard.value().parts), "old\nmultiline");
assert.equal(keyboard.press("ArrowDown"), true);
assert.equal(keyboard.press("ArrowDown"), true);
assert.equal(Composer.text(keyboard.value().parts), "");
assert.equal(keyboardFixture(draft("draft")).press("ArrowUp", {isComposing: true}), false);
assert.equal(keyboardFixture(draft("draft")).press("ArrowUp", {shiftKey: true}), false);
assert.equal(keyboardFixture({parts: draft("a\nb").parts, selection: {start: 3, end: 3}})
  .press("ArrowUp"), false);
assert.equal(keyboardFixture({parts: draft("selected").parts, selection: {start: 0, end: 3}})
  .press("ArrowUp"), false);
console.log("Prompt history checks passed.");
