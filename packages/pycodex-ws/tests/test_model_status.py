import subprocess
from pathlib import Path

import pytest

from pycodex import (
    Agent,
    AgentRuntime,
    AssistantMessage,
    ContextConfig,
    ModelResponse,
    ToolRegistry,
    UserMessage,
)
from pycodex.events import (
    ModelRequestStartedEvent,
    StreamErrorEvent,
    TurnCompletedEvent,
    TurnStartedEvent,
)
from tests.fakes import ScriptedModelClient
from workspace_server import WebSessionView
from workspace_server.workspaces import session_summary


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["manual", "mid_turn"])
async def test_compaction_exposes_the_model_it_uses(phase):
    class CompactClient:
        model = "primary"

        async def complete(self, prompt, event_handler):
            event_handler(ModelRequestStartedEvent("primary", "primary"))
            event_handler(ModelRequestStartedEvent("backup", "primary", "primary"))
            return ModelResponse([AssistantMessage("A short summary.")])

    agent = Agent(CompactClient(), ToolRegistry(), ContextConfig())
    agent._history.append(UserMessage("Summarize this conversation."))
    runtime = AgentRuntime(agent)
    view = WebSessionView()
    frontend = runtime.attach(view.handle_event)
    await agent._compact_history("compact-turn", phase)
    assert runtime.snapshot()["active_model"] == "backup"
    assert view.snapshot()["active_model"] == "backup"
    assert view.snapshot()["fallback_from_model"] == "primary"
    runtime.detach(frontend)
    await runtime.close()


@pytest.mark.asyncio
async def test_model_status_tracks_requests_restores_on_attach_and_keeps_fallback_note():
    runtime = AgentRuntime(
        Agent(ScriptedModelClient([], model="primary"), ToolRegistry(), ContextConfig())
    )
    view = WebSessionView()
    frontend = runtime.attach(view.handle_event)
    assert view.snapshot()["active_model"] == "primary"
    runtime._handle_agent_event(TurnStartedEvent("turn", ("hello",)))

    def request(model, previous=None):
        runtime.agent._handle_model_stream_event(
            "turn", ModelRequestStartedEvent(model, "primary", previous)
        )

    request("primary")
    runtime.agent._handle_model_stream_event(
        "turn",
        ModelRequestStartedEvent(
            "backup",
            "primary",
            "primary",
            fallback_reason="rate limited: retry after 8 seconds",
            failed_after_seconds=0.4,
        ),
    )
    assert runtime.snapshot()["active_model"] == "backup"
    assert runtime.snapshot()["selected_model"] == "primary"
    assert view.snapshot()["fallback_from_model"] == "primary"
    assert view.snapshot()["turns"][-1]["model_fallbacks"] == [
        "Fallback: primary → backup · rate limited: retry after 8 seconds "
        "· failed after 0.4s"
    ]
    assert view.snapshot()["fallback_reason"] == "rate limited: retry after 8 seconds"
    assert session_summary(view)["fallback_reason"] == (
        "rate limited: retry after 8 seconds"
    )
    assert session_summary(view)["active_model"] == "backup"

    # A fresh frontend attaching mid-turn must receive the current request model.
    restored = WebSessionView()
    restored_frontend = runtime.attach(restored.handle_event)
    assert restored.snapshot()["active_model"] == "backup"
    assert restored.snapshot()["turns"][-1]["model_fallbacks"] == [
        "Fallback: primary → backup · rate limited: retry after 8 seconds "
        "· failed after 0.4s"
    ]

    # Reusing a backup during cooldown is status, not another failed switch.
    runtime.agent._handle_model_stream_event(
        "turn",
        ModelRequestStartedEvent(
            "backup", "primary", fallback_cooldown_until=1700001900
        ),
    )
    assert view.snapshot()["active_model"] == "backup"
    assert view.snapshot()["fallback_from_model"] == "primary"
    assert view.snapshot()["fallback_cooldown_until"] == 1700001900
    assert len(view.snapshot()["turns"][-1]["model_fallbacks"]) == 1
    reattached = WebSessionView()
    third_frontend = runtime.attach(reattached.handle_event)
    assert reattached.snapshot()["fallback_cooldown_until"] == 1700001900
    assert session_summary(view)["fallback_cooldown_until"] == 1700001900

    # A subsequent request within this same turn returns to the primary model.
    request("primary")
    assert view.snapshot()["active_model"] == "primary"
    assert view.snapshot()["fallback_from_model"] is None
    assert view.snapshot()["fallback_cooldown_until"] is None
    assert restored.snapshot()["active_model"] == "primary"
    assert view.snapshot()["turns"][-1]["model_fallbacks"]
    runtime._handle_agent_event(TurnCompletedEvent("turn", 1, "done", 0))
    assert view.snapshot()["turns"][-1]["model_fallbacks"]

    runtime.set_model("other")
    assert view.snapshot()["active_model"] == "other"
    assert view.snapshot()["selected_model"] == "other"
    assert view.snapshot()["fallback_from_model"] is None
    runtime.detach(frontend)
    runtime.detach(restored_frontend)
    runtime.detach(third_frontend)
    await runtime.close()


@pytest.mark.asyncio
async def test_stream_error_details_are_visible_and_restored_mid_turn():
    runtime = AgentRuntime(
        Agent(ScriptedModelClient([], model="primary"), ToolRegistry(), ContextConfig())
    )
    view = WebSessionView()
    frontend = runtime.attach(view.handle_event)
    runtime._handle_agent_event(TurnStartedEvent("turn", ("hello",)))
    runtime.agent._handle_model_stream_event(
        "turn",
        StreamErrorEvent(
            "Falling back: primary -> backup",
            0,
            1,
            0.0,
            "upstream timed out before sending response data",
        ),
    )
    expected = [
        "Falling back: primary -> backup\n"
        "upstream timed out before sending response data"
    ]
    assert view.snapshot()["turns"][-1]["model_errors"] == expected

    restored = WebSessionView()
    restored_frontend = runtime.attach(restored.handle_event)
    assert restored.snapshot()["turns"][-1]["model_errors"] == expected

    runtime.detach(frontend)
    runtime.detach(restored_frontend)
    await runtime.close()


def test_model_indicator_and_fallback_notes_in_frontend():
    source = (
        Path(__file__).parents[1] / "workspace_server" / "workspace.html"
    ).read_text(encoding="utf-8")
    fragments = []
    for start, end in [
        ("    function updatePromptPlaceholder(", "    function updateContextMeter("),
        ("    function messageSignature(", "    async function pollSession("),
        ("    function renderTurn(", "    async function markVisibleFinalRead("),
    ]:
        fragments.append(source[source.index(start) : source.index(end)])
    script = (
        r"""
const assert = require("assert").strict;
const classes = new Set();
const modelIndicator = {
  textContent: "", title: "",
  classList: {add: value => classes.add(value), remove: value => classes.delete(value)},
};
const prompt = {dataset: {}, setAttribute() {}};
let activeSessionId = "one";
const sessions = {
  one: {
    model: "primary:high", selected_model: "primary",
    active_model: "backup", fallback_from_model: "primary",
    fallback_reason: "rate limited: retry after 8 seconds",
  },
  two: {model: "other:high", selected_model: "other", active_model: "other"},
};
function sessionById(id) { return sessions[id]; }
"""
        + "\n".join(fragments)
        + r"""
updatePromptPlaceholder();
assert.equal(modelIndicator.textContent,
  "Model backup · Fallback from primary · rate limited: retry after 8 seconds");
assert.ok(classes.has("fallback"));
updatePromptPlaceholder({
  ...sessions.one, fallback_cooldown_until: Date.now() / 1000 + 900,
});
assert.ok(modelIndicator.textContent.includes("Primary cooling down until"));
updatePromptPlaceholder({
  ...sessions.one, fallback_cooldown_until: Date.now() / 1000 - 1,
});
assert.ok(modelIndicator.textContent.includes("Primary retry on next request"));
const turn = {
  turn_id: "turn", response: "done", model_fallbacks: ["Fallback: primary → backup"],
  model_errors: ["Falling back: primary -> backup\nupstream timeout"],
};
const before = messageSignature({turns: [{...turn, model_errors: []}]});
assert.notEqual(before, messageSignature({turns: [turn]}));
const entries = [];
renderTurn(turn, (key, text, cls) => {
  entries.push({key, text, cls});
  return {dataset: {}};
});
assert.equal(entries.find(entry => entry.cls === "model-error").text,
             "Falling back: primary -> backup\nupstream timeout");
assert.equal(entries.find(entry => entry.cls === "model-fallback").text,
             "Fallback: primary → backup");
updatePromptPlaceholder({...sessions.one, active_model: "primary", fallback_from_model: null});
assert.equal(modelIndicator.textContent, "Model primary");
assert.ok(!classes.has("fallback"));
activeSessionId = "two";
updatePromptPlaceholder();
assert.equal(modelIndicator.textContent, "Model other");
assert.ok(!classes.has("fallback"));
updatePromptPlaceholder({});
assert.equal(modelIndicator.textContent, "");
assert.equal(modelIndicator.title, "");
"""
    )
    result = subprocess.run(["node", "-"], input=script, text=True, capture_output=True)
    assert result.returncode == 0, result.stdout + result.stderr
