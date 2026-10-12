import asyncio
import subprocess
import sys
import time

import pytest

from pycodex import (
    Agent,
    AgentRuntime,
    AssistantMessage,
    BaseTool,
    ContextConfig,
    ModelResponse,
    ToolCall,
    ToolRegistry,
    UserMessage,
)
from pycodex.cli import CliSessionView, run_interactive_session
from pycodex.events import AssistantDeltaEvent
from pycodex.runtime import SubmissionInterrupted
from pycodex.utils import uuid7_string
from pycodex.utils.session_persist import resolve_codex_home, rollout_path_for_session
from pycodex_ws import build_runtime as build_workspace_runtime
from pycodex_ws.feishu_card import PycodexCard
from pycodex_ws.feishu_link import PycodexRuntimeLink
from tests.fakes import ScriptedModelClient
from tests.test_session_backend import ControlClient, make_queue, question_payload
from workspace_server.app import (
    ThreadedWorkspaceInteractiveSession,
    WorkspaceInteractiveSession,
    create_app,
)


class ScriptedView(CliSessionView):
    def __init__(self, inputs):
        super().__init__()
        self.inputs = iter(inputs)
        self.lines = []
        self._line_output = self.lines.append
        self.display.color_enabled = False

    async def poll_prompt(self, prompt=None):
        try:
            return next(self.inputs)
        except StopIteration:
            raise EOFError()


async def run_frontend(frontend, queue, inputs):
    if frontend == "cli":
        view = ScriptedView(inputs)
        await run_interactive_session(queue, False, view=view)
        return
    if frontend == "web":
        session = await WorkspaceInteractiveSession(queue).start()
        try:
            for text in inputs:
                result = await session.submit(text)
                assert result["ok"]
        finally:
            await session.close()
        return
    link = PycodexRuntimeLink(
        queue,
        "unused",
        loop=asyncio.get_running_loop(),
        card=PycodexCard(),
    )
    await queue.start()
    link._frontend_id = queue.attach(link._handle_runtime_event)
    try:
        for text in inputs:
            result = await link._submit({"action": "send", "prompt": text})
            assert result["toast"]["type"] == "info"
    finally:
        await queue.close()
        link.detach()


@pytest.mark.parametrize("frontend", ["cli", "web", "feishu"])
@pytest.mark.asyncio
async def test_frontends_share_all_session_commands(frontend):
    session_id = uuid7_string()
    source = Agent(
        ControlClient([ModelResponse([AssistantMessage("old answer")])]),
        ToolRegistry(),
        ContextConfig(),
        session_file_path=rollout_path_for_session(resolve_codex_home(), session_id),
        session_id=session_id,
    )
    await source.run_turn(["old prompt"])
    old_id = source.session_id
    source.shutdown()
    client = ControlClient([ModelResponse([AssistantMessage("checkpoint")])])
    queue = make_queue(client)
    events = []
    queue.event_handler = events.append

    await run_frontend(
        frontend,
        queue,
        [
            "/help",
            "/model",
            "/model changed",
            "/resume",
            "/resume 1",
            "/title Shared title",
            "/title",
            "/history",
            "/fork",
            "/compact",
            "/unknown",
            "/exit",
        ],
    )

    results = [event.result for event in events if event.kind == "command_completed"]
    assert [result["kind"] for result in results] == [
        "help",
        "models",
        "model_changed",
        "sessions",
        "resumed",
        "title_changed",
        "title",
        "history",
        "forked",
        "compacted",
        "closed",
    ]
    assert results[7]["state"]["history"] == (("old prompt", "old answer"),)
    assert queue.title == "Shared title"
    assert queue.agent.model_name == "changed"
    assert queue.agent.session_id != old_id
    assert queue.agent.is_shutdown
    assert client.call_count == 1
    assert not any(
        item.text.startswith("/")
        for item in client.prompts[0].input
        if isinstance(item, UserMessage)
    )
    assert [event.command for event in events if event.kind == "command_failed"] == [
        "/unknown"
    ]


@pytest.mark.asyncio
async def test_state_changes_reach_every_frontend_and_detach_is_not_close():
    queue = make_queue()
    web = await WorkspaceInteractiveSession(queue).start()
    cli = ScriptedView([])
    cli_id = queue.attach(cli.handle_event)
    card = PycodexCard()
    card_id = queue.attach(card.apply_event)
    try:
        await queue.submit_input("/model changed")
        await queue.submit_input("/title Shared")
        assert web.snapshot()["model"] == card.model_name == "changed"
        assert (
            web.snapshot()["title"]
            == cli.display.title
            == card.display.title
            == "Shared"
        )
        assert card.render()["header"]["title"]["content"] == "Shared"
        web.detach()
        assert queue.agent.accepts_input
        await queue.submit_input("/model scripted")
        assert card.model_name == "scripted"
        assert web.snapshot()["model"] == "changed"
    finally:
        queue.detach(cli_id)
        queue.detach(card_id)
        cli.close()
        await queue.close()


@pytest.mark.parametrize("frontend", ["cli", "web", "feishu"])
@pytest.mark.asyncio
async def test_question_answers_use_same_backend_interpretation(frontend):
    queue = make_queue()
    ready = asyncio.Event()

    def handle_event(event):
        if event.kind == "input_requested":
            ready.set()

    observer = queue.attach(handle_event)
    manager = queue.agent.tool_registry.runtime_environment.request_user_input_manager
    request = asyncio.create_task(manager.request(question_payload()))
    await asyncio.wait_for(ready.wait(), 1)
    await run_frontend(frontend, queue, ["2", "0", "Custom answer"])
    assert await request == {
        "answers": {
            "first": {"answers": ["Beta"]},
            "second": {"answers": ["Custom answer"]},
        },
    }
    assert not queue.agent.history
    assert queue.agent.model_client.call_count == 0
    queue.detach(observer)


@pytest.mark.parametrize("frontend", ["cli", "web", "feishu"])
@pytest.mark.asyncio
async def test_request_user_input_stays_unavailable_with_frontend(frontend):
    from pycodex.tools import RequestUserInputTool

    client = ControlClient(
        [
            ModelResponse(
                [ToolCall("question", "request_user_input", question_payload())]
            ),
            ModelResponse([AssistantMessage("continued")]),
        ]
    )
    queue = make_queue(client)
    queue.agent.tool_registry.register(RequestUserInputTool())
    events = []
    queue.event_handler = events.append

    await run_frontend(frontend, queue, ["ask"])

    assert client.call_count == 2
    assert not any(event.kind == "input_requested" for event in events)
    result = client.prompts[1].input[-1]
    assert result.output == "request_user_input is unavailable in Default mode"
    assert "success" not in result.serialize()


@pytest.mark.asyncio
async def test_busy_feishu_input_steers_and_queue_remains_ordered():
    started = asyncio.Event()
    release = asyncio.Event()

    async def respond(prompt, call_count):
        if call_count == 1:
            started.set()
            await release.wait()
        return ModelResponse([AssistantMessage(str(call_count))])

    client = ControlClient(response_factory=respond)
    queue = make_queue(client)
    await queue.start()
    link = PycodexRuntimeLink(
        queue,
        "unused",
        loop=asyncio.get_running_loop(),
        card=PycodexCard(),
    )
    link._frontend_id = queue.attach(link._handle_runtime_event)
    try:
        first = await queue.submit_input("first", "cli")
        await started.wait()
        assert link.card.status is not None
        assert not link.card.render()["body"]["elements"][-1]["disabled"]
        assert (await link._submit({"action": "send", "prompt": "steered"}))["toast"][
            "type"
        ] == "info"
        queued = await queue.submit_input("/queue last", "web")
        rejected = await queue.submit_input("/model changed", "web")
        with pytest.raises(RuntimeError, match="running or queued"):
            await rejected.future
        release.set()
        with pytest.raises(SubmissionInterrupted):
            await first.future
        await queued.future
        assert [
            [item.text for item in prompt.input if isinstance(item, UserMessage)]
            for prompt in client.prompts
        ] == [
            ["first"],
            ["first", "steered"],
            ["first", "steered", "last"],
        ]
    finally:
        release.set()
        await queue.close()
        link.detach()


@pytest.mark.parametrize("cancel_caller", [False, True])
@pytest.mark.asyncio
async def test_close_waits_for_accepted_command_then_releases_connection(
    monkeypatch, cancel_caller
):
    started = asyncio.Event()
    release = asyncio.Event()
    detached = []

    class Link:
        session_key = "fake"
        message_id = "fake"

        def __init__(self, queue, target):
            pass

        async def start_async(self):
            started.set()
            await release.wait()
            return self

        def detach(self):
            detached.append(True)

    monkeypatch.setattr("pycodex_ws.feishu_link.PycodexRuntimeLink", Link)
    queue = build_workspace_runtime(
        Agent(ControlClient([]), ToolRegistry(), ContextConfig())
    )
    await queue.start()
    connecting = asyncio.create_task(queue.submit_input("/link fake"))
    await started.wait()
    closing = asyncio.create_task(queue.close())
    await asyncio.sleep(0)
    assert not closing.done()
    with pytest.raises(RuntimeError, match="shutting down"):
        await queue.submit_input("too late")
    if cancel_caller:
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closing
        assert not queue._worker.done()
    release.set()
    receipt = await connecting
    assert (await receipt.future)["kind"] == "connection"
    await asyncio.wait_for(queue.close(), 1)
    if not cancel_caller:
        await closing
    assert detached == [True]


def test_web_import_does_not_load_cli_frontend():
    code = (
        "import sys; import workspace_server.app; "
        "assert 'pycodex.cli' not in sys.modules; "
        "assert 'prompt_toolkit' not in sys.modules"
    )
    subprocess.run([sys.executable, "-c", code], check=True)


@pytest.mark.asyncio
async def test_late_frontends_restore_active_stream_and_follow_completion():
    started = asyncio.Event()
    release = asyncio.Event()
    deltas = (AssistantDeltaEvent("part"), AssistantDeltaEvent("ial"))

    class StreamingClient:
        model = "streaming"

        async def complete(self, prompt, event_handler):
            event_handler(deltas[0])
            started.set()
            await release.wait()
            event_handler(deltas[1])
            return ModelResponse([AssistantMessage("partial")])

    queue = make_queue(StreamingClient())
    events = []
    queue.event_handler = events.append
    await queue.start()
    receipt = await queue.submit_input("live")
    await started.wait()
    web = await WorkspaceInteractiveSession(queue).start()
    cli = ScriptedView([])
    cli_id = queue.attach(cli.handle_event)
    card = PycodexCard()
    card_id = queue.attach(card.apply_event)
    try:
        assert web.snapshot()["running"]
        assert web.snapshot()["turns"][-1]["thinking"] == "part"
        assert cli.display.stream_buffer == card.display.stream_buffer == "part"
        release.set()
        result = await receipt.future
        assert all(
            event.turn_id == "" and event.submission_id is None for event in deltas
        )
        assert [
            (event.delta, event.turn_id, event.submission_id)
            for event in events
            if isinstance(event, AssistantDeltaEvent)
        ] == [(event.delta, result.turn_id, receipt.submission_id) for event in deltas]
        assert len(web.snapshot()["turns"]) == 1
        assert web.snapshot()["turns"][0]["response"] == "partial"
        assert card.output_text == "partial"
        assert cli.lines.count("assistant> partial") == 1
        assert queue.snapshot()["active_turn"] is None
    finally:
        release.set()
        queue.detach(cli_id)
        queue.detach(card_id)
        cli.close()
        await web.close()


@pytest.mark.parametrize("threaded", [False, True])
@pytest.mark.parametrize("transport", ["http", "websocket"])
def test_web_transports_deliver_structured_answers(threaded, transport):
    from starlette.testclient import TestClient

    class QuestionTool(BaseTool):
        name = "question_fixture"
        description = "Exercise the runtime input transport."

        def __init__(self, manager):
            self.manager = manager

        async def run(self, context, args):
            return await self.manager.request(args)

    client = ControlClient(
        [
            ModelResponse(
                [ToolCall("question", "question_fixture", question_payload())]
            ),
            ModelResponse([AssistantMessage("answered")]),
        ]
    )

    def build_session():
        tools = ToolRegistry()
        tools.register(
            QuestionTool(tools.runtime_environment.request_user_input_manager)
        )
        return WorkspaceInteractiveSession(
            AgentRuntime(Agent(client, tools, ContextConfig()))
        )

    def build_frontend():
        if threaded:
            return ThreadedWorkspaceInteractiveSession(
                build_session, asyncio.get_running_loop()
            )
        return build_session()

    with TestClient(create_app(build_frontend, None)) as browser:
        assert (
            browser.post("/api/session/message", json={"prompt": "ask"}).status_code
            == 200
        )
        for attempt in range(100):
            state = browser.get("/api/session").json()["snapshot"]
            if state["input_request"] is not None:
                break
            time.sleep(0.01)
        assert state["input_request"] is not None
        assert "Choose a path" in state["input_request"]["text"]
        assert len(state["turns"]) == 1
        answer = {
            "request_id": state["input_request"]["request_id"],
            "answer": {
                "answers": {
                    "first": {"answers": ["Alpha"]},
                    "second": {"answers": ["Gamma"]},
                }
            },
        }
        if transport == "http":
            response = browser.post("/api/session/message", json=answer)
            assert response.status_code == 200
            assert response.json()["type"] == "answered"
        else:
            with browser.websocket_connect("/ws/session") as websocket:
                websocket.send_json(dict(answer, type="answer"))
                for attempt in range(100):
                    response = websocket.receive_json()
                    if response["type"] == "send_result":
                        break
                assert response["result"]["type"] == "answered"
        stale = browser.post("/api/session/message", json=answer)
        assert stale.status_code == 400
        assert "no longer pending" in stale.json()["error"]
        for attempt in range(100):
            state = browser.get("/api/session").json()["snapshot"]
            if state["turns"][-1]["status"] == "completed":
                break
            time.sleep(0.01)
        assert state["input_request"] is None
        assert len(state["turns"]) == 1
        assert state["turns"][-1]["response"] == "answered"
    assert client.call_count == 2


def test_ipython_bootstrap_keeps_bare_agent(monkeypatch):
    import pycodex_ws.ipython

    client = ControlClient([])
    agent = Agent(client, ToolRegistry(), ContextConfig())
    attached = []
    monkeypatch.setattr(pycodex_ws.ipython, "build_model", lambda path: client)
    monkeypatch.setattr(pycodex_ws.ipython, "build_agent", lambda **kwargs: agent)
    monkeypatch.setattr(
        "pycodex_ws.ipython.attach_ipython_tool", attached.append
    )
    assert pycodex_ws.ipython.ipython_agent("unused") is agent
    assert attached == [agent]
    assert not hasattr(agent, "submission_queue")


@pytest.mark.asyncio
async def test_interactive_commands_reject_direct_background_work(monkeypatch):
    started = asyncio.Event()
    release = asyncio.Event()

    async def response_factory(prompt, call_count):
        started.set()
        await release.wait()
        return ModelResponse([AssistantMessage("done")])

    model = ScriptedModelClient(response_factory=response_factory)
    model.model = "original"
    agent = Agent(model, ToolRegistry(), ContextConfig())
    session = WorkspaceInteractiveSession(AgentRuntime(agent))
    lines = []
    commands_handled = asyncio.Event()

    def record_line(text):
        lines.append(text)
        if "Cannot resume" in text:
            commands_handled.set()

    monkeypatch.setattr(session.view, "show_error", record_line)
    await session.start()
    await asyncio.sleep(0)
    turn = asyncio.create_task(agent.run_turn(["background"]))
    try:
        await asyncio.wait_for(started.wait(), 1)
        for command in ["/model changed", "/compact", "/fork", "/resume 1"]:
            await asyncio.wait_for(session.submit(command), 1)
        await asyncio.wait_for(commands_handled.wait(), 1)
        output = "\n".join(lines)
        for message in [
            "Cannot change model",
            "Cannot compact",
            "Cannot fork",
            "Cannot resume",
        ]:
            assert message in output
        assert agent.model_name == "original"
        assert model.call_count == 1
    finally:
        release.set()
        await turn
        await session.close()
