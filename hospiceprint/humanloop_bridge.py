"""Private stdio adapter from HumanLoop's verified Cognito sessions to AgenticPrint.

No HTTP listener and no credentials returned to the browser. The parent backend
is the authentication boundary; it supplies fresh, server-read policy snapshots.
Workload attestation, print validation, key-bound grants, request proofs and MCP
authorization use the original AgenticPrint implementation.
"""
from __future__ import annotations
import json
import os
import sys
from pathlib import Path
import jwt
from .audit import AuditLog
from .crypto import new_id, now
from .grants import GrantService, GATEWAY_AUDIENCE
from .gateway import MCPGateway
from .policy import PolicyEngine, CareTeamRegistry, ToolSpec, Decision, PATRQT
from .revocation import RevocationRegistry
from .workload import AgentRuntime, WorkloadRegistry


class VerifiedSessionGrants(GrantService):
    def exchange_verified_session(self, runtime, subject, resident, tools):
        # Called only inside the private bridge after the parent verifies Cognito
        # membership/run ownership. This is backend workload identity, not a fake PIN.
        reg = self._verify_workload(runtime.attest(), subject)
        rev = self.revocations.check(agent=reg.agent_id, print_id=reg.print_id, sponsor=subject)
        if rev:
            self._deny('companion revoked', 'revoked')
        granted = [t for t in tools if t in reg.max_tools and t in self.catalog]
        t, sid = now(), new_id('ses')
        claims = dict(iss=self.issuer, aud=GATEWAY_AUDIENCE, sub=subject,
                      act={'sub': reg.agent_id}, role='patient_companion',
                      patient_binding=resident, tenant=reg.tenant, tools=granted,
                      pou=PATRQT, print=reg.print_id, sid=sid,
                      cnf={'jkt': reg.key_thumbprint}, iat=t, exp=t + self.ttl,
                      jti=new_id('tok'), break_glass=False)
        token = jwt.encode(claims, self._key, algorithm='ES256', headers={'kid': self.kid})
        self.sessions[sid] = {'sid': sid, 'agent': reg.agent_id, 'calls': 0}
        return {'token': token, 'expires': t + self.ttl, 'sid': sid}


class HumanLoopPolicy(PolicyEngine):
    current = None
    def evaluate(self, claims, tool, args):
        c = self.current or {}
        bound = claims.get('patient_binding')
        if c.get('resident_id') != bound or c.get('subject') != claims.get('sub'):
            return Decision(False, 'Resident identity does not match this companion', 'patient-binding')
        target = args.get('patient_id') or bound
        if target != bound:
            return Decision(False, 'Another resident’s private information is outside this companion’s role', 'patient-binding')
        if tool == 'claim_staff_privileges':
            return Decision(False, 'Staff authentication is required; conversation cannot change a role', 'staff-authentication')
        if tool == 'change_medication':
            return Decision(False, 'Changing treatment or medication is outside the companion’s role', 'role-ceiling')
        if tool == 'read_clinical_information' and c.get('mode') != 'clinical':
            return Decision(False, 'Clinical information requires a separately authorized health check-in', 'clinical-workflow')
        if tool == 'use_camera':
            return Decision(False, 'Camera access is not enabled in this demonstration', 'camera-disabled')
        base = super().evaluate(claims, tool, args)
        if not base.allow:
            return base
        if c.get('paused'):
            return Decision(False, 'Administrator paused this companion', 'companion-paused')
        if c.get('mode') == 'clinical':
            if not c.get('clinical_authorized'):
                return Decision(False, 'A separately authorized clinical check-in is required', 'clinical-workflow')
            return Decision(True, 'Clinical run identity, scope and consent verified', 'clinical-workflow')
        cap = c.get('capability')
        if cap and not c.get('capabilities', {}).get(cap, False):
            return Decision(False, 'Administrator disabled this capability', 'capability-disabled')
        if cap and not c.get('consents', {}).get(cap, False):
            return Decision(False, 'Resident consent does not permit this function', 'resident-consent')
        if tool == 'check_friend_attendance' and not c.get('attendance_shared'):
            return Decision(False, 'Attendance has not been shared with this resident', 'attendance-consent')
        return Decision(True, 'Capability, resident consent and access boundary verified', 'allow')


class ApprovalBoundary:
    name = 'humanloop-protected-tools'
    def call(self, tool, args):
        # Business effects happen in Node only after this real MCP authorization,
        # with DynamoDB transaction guards rechecking the same policy versions.
        return {'authorized': True, 'tool': tool}


class Bridge:
    def __init__(self, key_file):
        self.key_file = Path(key_file)
        self.keys = json.loads(self.key_file.read_text()) if self.key_file.exists() else {}
        self.audit, self.registry = AuditLog(), WorkloadRegistry()
        self.revocations = RevocationRegistry(self.audit)
        self.runtimes, self.bindings, self.tokens = {}, {}, {}
        self.catalog = {}
        self.grants = VerifiedSessionGrants('humanloop-agentprint', None, self.registry, self.catalog, self.revocations, self.audit)
        self.policy = HumanLoopPolicy(self.catalog, CareTeamRegistry(self.audit), ApprovalBoundary())
        self.gateway = MCPGateway(self.grants, self.revocations, self.policy, ApprovalBoundary(), self.audit)

    def initialize(self, config):
        for mode, manifest in config['manifests'].items():
            for tool in manifest['tools']:
                self.catalog[tool] = ToolSpec(tool, tool, 'low', {PATRQT}, {'type': 'object'})
            for resident in config['residents']:
                aid = f'humanloop:{resident}:{mode}'
                kwargs = dict(agent_id=aid, tenant='carealong-demo', model=manifest['model'], system_prompt=manifest['prompt'], toolset=manifest['tools'])
                runtime = AgentRuntime.from_pem(self.keys[aid].encode(), **kwargs) if aid in self.keys else AgentRuntime(**kwargs)
                self.runtimes[aid] = runtime
                self.keys[aid] = runtime.private_pem().decode()
                self.registry.register(runtime.registration(f'{resident} companion ({mode})', ['patient_companion'], manifest['tools']))
        self.key_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.key_file.with_suffix('.tmp')
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(self.keys, stream)
        os.replace(str(tmp), str(self.key_file))
        os.chmod(str(self.key_file), 0o600)
        return {'identities': [self.describe(aid) for aid in self.runtimes]}

    def describe(self, aid):
        reg = self.registry.get(aid)
        return {'agent_id': aid, 'print_id': reg.print_id, 'key_thumbprint': reg.key_thumbprint,
                'model': reg.model, 'prompt_hash': reg.prompt_sha256, 'toolset_hash': reg.toolset_sha256,
                'registered_at': reg.registered_at, 'key_location': 'voice backend', 'token_ttl_seconds': self.grants.ttl}

    def authorize(self, value):
        context = value['context']
        run, resident, subject, mode = (value[k] for k in ('run_id', 'resident_id', 'subject', 'mode'))
        binding = (resident, subject, mode)
        if run in self.bindings and self.bindings[run] != binding:
            return {'allowed': False, 'rule': 'patient-binding', 'reason': 'Run identity cannot be changed'}
        self.bindings[run] = binding
        aid = f'humanloop:{resident}:{mode}'
        runtime = self.runtimes[aid]
        if run not in self.tokens or self.tokens[run]['expires'] <= now() + 10:
            self.tokens[run] = self.grants.exchange_verified_session(runtime, subject, resident, runtime.toolset)
        grant = self.tokens[run]
        self.policy.current = {**context, 'resident_id': resident, 'subject': subject, 'mode': mode}
        tool, args = value['tool'], dict(value.get('args') or {})
        proof = runtime.proof(grant['token'], 'tools/call', tool)
        response = self.gateway.handle({'Authorization': f"AgentPrint {grant['token']}", 'Print-Proof': proof},
                                       {'jsonrpc': '2.0', 'id': value.get('id'), 'method': 'tools/call', 'params': {'name': tool, 'arguments': args}})
        audit = self.audit.tail(1)[0]
        error = response.body.get('error')
        return {'allowed': error is None, 'reason': error['message'] if error else audit.get('reason', 'Allowed'),
                'rule': (error.get('data') or {}).get('rule', 'identity') if error else audit.get('rule', 'allow'),
                'identity': self.describe(aid), 'grant_session': grant['sid'], 'audit_hash': audit['hash'],
                'policy_version': context.get('policy_version')}


def main():
    bridge = Bridge(os.environ['HUMANLOOP_KEY_FILE'])
    for line in sys.stdin:
        message = {}
        try:
            if len(line) > 100000:
                raise ValueError('Message too large')
            message = json.loads(line)
            result = bridge.initialize(message) if message['op'] == 'initialize' else bridge.authorize(message)
            print(json.dumps({'id': message['id'], 'result': result}), flush=True)
        except Exception as error:
            # Never dump keys, tokens, payloads or tracebacks to stdout.
            print(json.dumps({'id': message.get('id'), 'error': type(error).__name__}), flush=True)

if __name__ == '__main__':
    main()
