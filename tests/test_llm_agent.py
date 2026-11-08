"""LLM-driven agent tests. Bedrock is stubbed: the stub validates the Converse request shape
and answers like Claude would (including a reasoning block that must be replayed)."""
import copy
import re
import unittest

from hospiceprint.agent import AgentClient
from hospiceprint.crypto import totp
from hospiceprint.llm_agent import (BedrockLLM, ReplayLLM, mcp_tools_to_bedrock, run_llm_agent,
                                    to_bedrock_name, to_mcp_name)
from hospiceprint.system import DEMO_PASSWORD, build_system

NAME_RE = re.compile(r"[a-zA-Z0-9_-]{1,64}")


class ValidationException(Exception):
    pass


class StubBedrock:
    """Pretends to be boto3's bedrock-runtime client."""

    def __init__(self, plan, reject_effort=False):
        self.plan = list(plan)  # list of (tool_mcp_name, args) then final text
        self.requests = []
        self.reject_effort = reject_effort

    def converse(self, **req):
        self.requests.append(copy.deepcopy(req))
        assert req["modelId"]
        assert req["system"][0]["text"]
        for t in req["toolConfig"]["tools"]:
            spec = t["toolSpec"]
            assert NAME_RE.fullmatch(spec["name"]), spec["name"]
            assert spec["inputSchema"]["json"]["type"] == "object"
        if self.reject_effort and "additionalModelRequestFields" in req:
            raise ValidationException("ValidationException: unsupported field output_config")
        # every assistant message we sent back earlier must be replayed unchanged
        for m in req["messages"]:
            if m["role"] == "assistant":
                assert m["content"][0] == {"reasoningContent": {"reasoningText": {"text": "thinking", "signature": "sig"}}}
        if not self.plan:
            return {"stopReason": "end_turn", "output": {"message": {"role": "assistant", "content": [
                {"reasoningContent": {"reasoningText": {"text": "thinking", "signature": "sig"}}},
                {"text": "All done."}]}}}
        tool, args = self.plan.pop(0)
        return {"stopReason": "tool_use", "output": {"message": {"role": "assistant", "content": [
            {"reasoningContent": {"reasoningText": {"text": "thinking", "signature": "sig"}}},
            {"toolUse": {"toolUseId": f"t{len(self.requests)}", "name": to_bedrock_name(tool), "input": args}}]}}}


class Base(unittest.TestCase):
    def setUp(self):
        self.s = build_system()
        self.tok = self.s.directory.authenticate("grace.okafor", DEMO_PASSWORD["grace.okafor"],
                                                 totp(self.s.totp_secret("grace.okafor")))
        self.events = []

    def run_with(self, llm, user_tok=None, **kw):
        return run_llm_agent(AgentClient(self.s.agent_runtime, system=self.s), user_tok or self.tok,
                             "prep my visits", llm, self.events.append, **kw)


class TestMapping(unittest.TestCase):
    def test_names_roundtrip_and_valid(self):
        self.assertEqual(to_mcp_name(to_bedrock_name("patients.get_summary")), "patients.get_summary")
        specs = mcp_tools_to_bedrock([{"name": "meds.get_list", "description": "d",
                                       "inputSchema": {"type": "object", "properties": {}}}])
        self.assertTrue(NAME_RE.fullmatch(specs[0]["toolSpec"]["name"]))


class TestBedrockLoop(Base):
    def test_model_only_sees_granted_tools(self):
        stub = StubBedrock([])
        self.run_with(BedrockLLM(client=stub))
        names = {t["toolSpec"]["name"] for t in stub.requests[0]["toolConfig"]["tools"]}
        self.assertNotIn(to_bedrock_name("meds.order_controlled"), names)
        self.assertNotIn(to_bedrock_name("billing.submit_claim"), names)
        self.assertEqual(len(names), 8)

    def test_allow_and_deny_flow_back_to_model(self):
        stub = StubBedrock([("patients.get_summary", {"patient_id": "P-1001"}),
                            ("patients.get_summary", {"patient_id": "P-2001"})])
        stats = self.run_with(BedrockLLM(client=stub))
        self.assertEqual((stats["allowed"], stats["denied"]), (1, 1))
        last_user = stub.requests[-1]["messages"][-1]
        tr = last_user["content"][0]["toolResult"]
        self.assertEqual(tr["status"], "error")
        self.assertIn("care team", tr["content"][0]["text"])
        ok = stub.requests[-2]["messages"][-1]["content"][0]["toolResult"]
        self.assertNotIn("payer", ok["content"][0]["json"])  # minimum necessary reaches the model too

    def test_revocation_mid_task_blocks_and_halts(self):
        plan = [("patients.get_summary", {"patient_id": "P-1001"})] + \
               [("meds.get_list", {"patient_id": "P-1001"})] * 5
        stub = StubBedrock(plan)

        def emit(e):
            self.events.append(e)
            if e.get("tool") and e["kind"] == "allow":
                self.s.revocations.revoke("agent", self.s.agent_runtime.agent_id, "test", "nina.ross")

        stats = run_llm_agent(AgentClient(self.s.agent_runtime, system=self.s), self.tok, "go",
                              BedrockLLM(client=stub), emit)
        self.assertTrue(stats["revoked"])
        self.assertEqual(stats["allowed"], 1)
        self.assertLessEqual(stats["tool_calls"], 3)  # halted after repeated blocked calls
        self.assertTrue(any(e["label"] == "Agent requests a fresh grant" and e["kind"] == "blocked"
                            for e in self.events))

    def test_effort_field_dropped_on_validation_error(self):
        stub = StubBedrock([], reject_effort=True)
        self.run_with(BedrockLLM(client=stub, effort="low"))
        self.assertIn("additionalModelRequestFields", stub.requests[0])
        self.assertNotIn("additionalModelRequestFields", stub.requests[1])

    def test_grok_uses_its_own_effort_field_and_label(self):
        stub = StubBedrock([])
        llm = BedrockLLM(client=stub, model_id="us.xai.grok-4.7", effort="low")
        self.run_with(llm)
        self.assertEqual(stub.requests[0]["modelId"], "us.xai.grok-4.7")
        self.assertEqual(stub.requests[0]["additionalModelRequestFields"], {"reasoning_effort": "low"})
        self.assertIn("Grok", llm.label)

    def test_model_failure_is_reported(self):
        class Broken:
            def converse(self, **_):
                raise RuntimeError("AccessDeniedException: no model access")
        stats = self.run_with(BedrockLLM(client=Broken()))
        self.assertIn("AccessDenied", stats["model_error"])
        self.assertEqual(stats["tool_calls"], 0)

    def test_aide_sponsor_shrinks_model_toolset(self):
        stub = StubBedrock([])
        aide = self.s.directory.authenticate("maya.chen", DEMO_PASSWORD["maya.chen"],
                                             totp(self.s.totp_secret("maya.chen")))
        self.run_with(BedrockLLM(client=stub), user_tok=aide)
        self.assertEqual(len(stub.requests[0]["toolConfig"]["tools"]), 3)


class TestReplay(Base):
    def test_replay_runs_full_plan(self):
        stats = self.run_with(ReplayLLM())
        self.assertEqual(stats["tool_calls"], 10)
        self.assertEqual(stats["denied"], 3)   # Part 2 consent, Walter not on care team, unauthorized neighbor
        self.assertEqual(stats["allowed"], 7)
        self.assertTrue(self.s.audit.verify()[0])


if __name__ == "__main__":
    unittest.main()
