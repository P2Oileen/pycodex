export function sample() {
  return {agents: [
    {agent_id: "a1", parent_agent_id: "root", nickname: "Explorer", status: "running"},
    {agent_id: "a2", parent_agent_id: "a1", nickname: "Reviewer", status: {completed: "Checked the changed files."}},
    {agent_id: "a3", parent_agent_id: "root", nickname: "Tester", status: {errored: "Sample test failure"}},
    {agent_id: "a4", parent_agent_id: "root", nickname: "<b>literal name</b>", status: "shutdown"},
    {agent_id: "a5", parent_agent_id: "root", nickname: "Starting", status: "pending_init"},
  ]};
}

export function check(root) {
  if (root.querySelectorAll("li").length !== 5 ||
      !root.textContent.includes("1 running") ||
      !root.textContent.includes("Parent: a1") ||
      !root.textContent.includes("completed") ||
      !root.textContent.includes("Sample test failure") ||
      root.querySelector("b")) throw new Error("Subagent tree/status rendering failed");
}
