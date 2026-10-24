export function sample() {
  return {source: "rollout", next_cursor: "older-page", items: [
    {index: 10, type: "response_item", payload: {type: "function_call_output", call_id: "earlier", output: "Earlier result"}},
    {index: 11, type: "response_item", payload: {type: "function_call", call_id: "call-1", name: "exec_command", arguments: '{"cmd":"python -m pytest"}'}},
    {index: 12, type: "response_item", payload: {type: "function_call_output", call_id: "call-1", output: [{type: "input_text", text: "<b>10 tests passed</b>"}]}},
    {index: 13, type: "response_item", payload: {type: "custom_tool_call", call_id: "call-2", name: "apply_patch", input: "*** Begin Patch\n…"}},
    {index: 14, type: "response_item", payload: {type: "custom_tool_call_output", call_id: "call-2", name: "apply_patch", output: "Updated sample.py"}},
    {index: 15, type: "response_item", payload: {type: "function_call", call_id: "call-3", name: "exec_command", arguments: '{"cmd":"build"}'}},
  ]};
}

export function empty() {
  return {next_cursor: null, items: [
    {type: "response_item", payload: {type: "message", role: "assistant", content: []}},
  ]};
}

export function check(root) {
  if (root.getClientRects().length === 0 || root.querySelectorAll("[data-call-id]").length !== 4 ||
      !root.textContent.includes("Earlier tool call") ||
      !root.textContent.includes("no recorded result in this page") ||
      !root.textContent.includes("Updated sample.py") ||
      !root.textContent.includes("<b>10 tests passed</b>") ||
      root.querySelector("b")) throw new Error("Tool call/result pairing or text rendering failed");
}
