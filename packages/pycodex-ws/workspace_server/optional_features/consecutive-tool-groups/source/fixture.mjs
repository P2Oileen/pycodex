export function sample() {
  return [
    {call_id: "inspect", name: "exec_command", status: "completed",
      arguments: {cmd: "git status --short"}, output: " M example.py"},
    {call_id: "patch", name: "apply_patch", status: "error",
      input: "*** Begin Patch\n*** Update File: example.py\n…\n*** End Patch",
      output: "Patch context did not match."},
    {call_id: "tests", name: "exec_command", status: "running",
      arguments: {cmd: "python -m pytest"}, output: undefined},
  ];
}
