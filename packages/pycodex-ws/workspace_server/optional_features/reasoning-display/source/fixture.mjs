export function sample() {
  return {source: "rollout", next_cursor: null, items: [
    {index: 20, type: "response_item", payload: {type: "reasoning", summary: [{type: "summary_text", text: "Check the request and compare the available inputs."}], content: null}},
    {index: 21, type: "response_item", payload: {type: "reasoning", summary: [], content: [{type: "reasoning_text", text: "<b>This is literal recorded text.</b>"}]}},
    {index: 22, type: "response_item", payload: {type: "reasoning", encrypted_content: "TEST_OPAQUE_DATA_DO_NOT_RENDER", summary: [], content: null}},
    {index: 23, type: "response_item", payload: {type: "message", role: "assistant", content: [{type: "output_text", text: "ASSISTANT_TEXT_DO_NOT_RENDER"}]}},
  ]};
}

export function check(root) {
  if (root.querySelectorAll("section").length !== 3 ||
      !root.textContent.includes("Check the request") ||
      !root.textContent.includes("<b>This is literal recorded text.</b>") ||
      !root.textContent.includes("No readable reasoning was returned") ||
      root.textContent.includes("TEST_OPAQUE_DATA_DO_NOT_RENDER") ||
      root.textContent.includes("ASSISTANT_TEXT_DO_NOT_RENDER") ||
      root.querySelector("b")) throw new Error("Readable reasoning filtering failed");
}
