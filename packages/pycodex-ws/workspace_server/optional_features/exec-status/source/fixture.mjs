export function sample() {
  return {background_work: [
    {tool: "exec_command", kind: "exec", session_id: 42, pid: 1042, tty: false, status: "running", exit_code: null},
    {tool: "exec_command", kind: "exec", session_id: 43, pid: 1043, tty: true, status: "exited", exit_code: 0},
    {tool: "clock", kind: "clock", enabled: true, period_m: 5, status: "armed", next_fire_at: null},
  ]};
}

export function check(root) {
  if (root.querySelectorAll("li").length !== 2 ||
      !root.textContent.includes("1 running") ||
      !root.textContent.includes("exited (0)") ||
      !root.textContent.includes("PID 1042")) throw new Error("Exec inventory rendering failed");
}
