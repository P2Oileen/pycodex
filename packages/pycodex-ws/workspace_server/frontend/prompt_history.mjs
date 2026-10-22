import {Composer} from "./composer.mjs";

function automaticPrompt(text) {
  const match = text.trim().match(/^<(clock_tick|exec_command_completed)>\s*([\s\S]*?)\s*<\/\1>$/);
  if (!match) return false;
  try {
    const payload = JSON.parse(match[2]);
    return payload !== null && typeof payload === "object" && !Array.isArray(payload);
  } catch {
    return false;
  }
}

/** Human input history belongs to one conversation and never submits on recall. */
export class PromptHistory {
  constructor() {
    this.entries = [];
    this.seen = new Set();
    this.pending = [];
    this.index = null;
    this.draft = null;
  }

  remember(value) {
    const parts = value.parts.map(part => ({...part}));
    if (!Composer.text(parts).trim()) return;
    this.append({parts});
    this.pending.push(Composer.text(parts).trim());
    if (this.pending.length > 100) this.pending.shift();
    this.reset();
  }

  append(value) {
    this.entries.push(value);
    if (this.entries.length > 100) {
      this.entries.shift();
      if (this.index !== null) this.index = Math.max(0, this.index - 1);
    }
  }

  update(turns) {
    for (const turn of turns || []) {
      const id = turn.submission_id || turn.turn_id;
      if (!id || this.seen.has(id)) continue;
      this.seen.add(id);
      const text = turn.prompt;
      if (!text || !text.trim()) continue;
      const pending = this.pending.indexOf(text.trim());
      if (pending !== -1) {
        this.pending.splice(pending, 1);
        continue;
      }
      if (turn.kind === "compaction" || automaticPrompt(text) ||
          !["web", "cli", "feishu", "resume", "user"].includes(turn.sender)) continue;
      this.append({parts: [{type: "text", text}]});
    }
  }

  reset() {
    this.index = null;
    this.draft = null;
  }

  recall(back, current) {
    if (this.index !== null &&
        JSON.stringify(current.parts) !== JSON.stringify(this.entries[this.index].parts)) this.reset();
    if (back) {
      if (!this.entries.length || this.index === 0) return null;
      if (this.index === null) {
        this.draft = current;
        this.index = this.entries.length;
      }
      this.index -= 1;
    } else {
      if (this.index === null) return null;
      this.index += 1;
      if (this.index >= this.entries.length) {
        const draft = this.draft;
        this.reset();
        return draft;
      }
    }
    return {parts: this.entries[this.index].parts.map(part => ({...part}))};
  }
}
