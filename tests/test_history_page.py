from pycodex.protocol import AssistantMessage, ContextMessage, ToolCall, ToolResult, UserMessage
from pycodex.utils.session_persist import SessionRolloutRecorder, read_rollout_history_page


def test_rollout_pagination_keeps_tools_and_pre_compaction_history(tmp_path):
    path = tmp_path / "history.jsonl"
    recorder = SessionRolloutRecorder.create(
        tmp_path, "test-session", tmp_path, "test", None, "", path,
    )
    history = [
        UserMessage("first"), ToolCall("call-1", "echo", {"text": "value"}),
        ToolResult("call-1", "echo", "result"), AssistantMessage("answer"),
    ]
    recorder.append_history_items(history)
    recorder.append_compacted_history([ContextMessage("summary")])
    recorder.append_history_items([UserMessage("second"), AssistantMessage("last")])
    original = path.read_bytes()
    pages = []
    before = None
    while True:
        page = read_rollout_history_page(path, before, 2)
        pages.insert(0, page["items"])
        before = page["next_before"]
        if before is None:
            break
    items = [item for page in pages for item in page]
    assert len(items) == 7
    assert [item["index"] for item in items] == list(range(7))
    assert items[1]["payload"]["type"] == "function_call"
    assert items[2]["payload"]["type"] == "function_call_output"
    assert items[4] == {"index": 4, "type": "compacted", "payload": {"message": "summary"}}
    assert path.read_bytes() == original
