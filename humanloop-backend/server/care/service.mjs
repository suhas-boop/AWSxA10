import { dailyPlanContext } from './daily-checkin.mjs';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import Ajv from 'ajv';
import { RunLocks, Conflict } from './store.mjs';
import { orgPK, residentPK, TOOL_NAMES, residents } from './fixtures.mjs';
import { PROTOCOL, advance, detectTopic, explicitEmergency, questionFor, references, EMERGENCY, URGENT } from './rules.mjs';

export class CareError extends Error { constructor(code, status = 403) { super(code); this.code = code; this.status = status; } }
const id = prefix => `${prefix}_${randomUUID()}`;
const now = () => Date.now();
const utc = () => new Date().toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const put = (item, expectedVersion = null) => ({ kind: 'put', item, expectedVersion });
const check = (item, extra = {}) => ({ kind: 'check', pk: item.pk, sk: item.sk, expectedVersion: item.version, ...extra });
const objectSchema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string', minLength: 1, maxLength: 100 };
export const toolDefinitions = [
  { name: 'get_checkin_context', description: 'Read only the bound resident’s permitted context, current observations, and the next approved question. Consult before responding.', schema: objectSchema({}) },
  { name: 'propose_follow_up', description: 'Prepare a care-team handoff for a confirmed incident. The resident must review and confirm it in the app.', schema: objectSchema({ incident_id: string, assistance: { type: 'string', minLength: 1, maxLength: 500 } }) },
  { name: 'create_review_task', description: 'Create an assigned task using a server-issued, single-use human confirmation. Never invent confirmation identifiers.', schema: objectSchema({ draft_id: string, confirmation_id: string, request_id: string }) },
  { name: 'get_review_status', description: 'Read a bound resident’s task acknowledgment and the next step entered by an assigned human.', schema: objectSchema({ task_id: string }) },
];
const ajv = new Ajv({ strict: true });
const validators = new Map(toolDefinitions.map(tool => [tool.name, ajv.compile(tool.schema)]));

export class CareService {
  constructor({ store, verifyMachine, machineToken, machineClientId, clock = now }) {
    Object.assign(this, { store, verifyMachine, machineToken, machineClientId, clock });
    this.locks = new RunLocks(); this.bindings = new Map(); this.voiceStops = new Map();
  }
  async member(principal) {
    if (!principal?.sub || !Number.isFinite(principal.exp) || principal.exp * 1000 <= this.clock()) throw new CareError('AUTH_INVALID', 401);
    const member = await this.store.get(orgPK, `MEMBER#${principal.sub}`);
    if (!member?.active) throw new CareError('AUTH_INVALID', 401);
    return member;
  }
  async residentMember(principal) {
    const member = await this.member(principal);
    if (member.role !== 'resident') throw new CareError('RESIDENT_SCOPE_DENIED');
    return member;
  }
  async ownedRun(principal, runId, active = true) {
    const member = await this.residentMember(principal);
    const run = await this.store.get(residentPK(member.residentId), `RUN#${runId}`);
    if (!run || run.actor !== member.subject) throw new CareError('RESIDENT_SCOPE_DENIED');
    if (active && (run.state !== 'ACTIVE' || run.leaseUntil <= this.clock() || run.expiresAt <= this.clock())) throw new CareError('RUN_STOPPED');
    return { member, run };
  }
  async startRun(principal, consent) {
    if (consent !== true) throw new CareError('CONFIRMATION_REQUIRED', 400);
    const member = await this.residentMember(principal);
    return this.locks.with(`resident:${member.residentId}`, async () => {
      const previous = (await this.store.query(residentPK(member.residentId), 'RUN#')).filter(r => r.state === 'ACTIVE');
      for (const run of previous) await this.stopRun(principal, run.id);
      const token = await this.machineToken(); await this.verifyMachine(token, 'get_checkin_context');
      const runId = id('run'), pk = residentPK(member.residentId), consentId = id('consent');
      const run = { pk, sk: `RUN#${runId}`, id: runId, type: 'AgentRun', version: 1, actor: member.subject, agent_subject: this.machineClientId,
        residentId: member.residentId, alias: member.name, device_id: id('device'), consent_ref: consentId, state: 'ACTIVE', createdAt: utc(),
        login_jti: principal.jti || null, human_expires_at: principal.exp * 1000,
        leaseUntil: this.clock() + 8000, expiresAt: this.clock() + 30 * 60000, incidentId: null, detector: 'unavailable', analysis: 'typed-only' };
      const grants = TOOL_NAMES.map(tool => ({ pk, sk: `GRANT#${runId}#${tool}`, id: id('grant'), run_id: runId, tool, resource_scope: member.residentId, version: 1, expiresAt: run.expiresAt, revokedAt: null }));
      const consentRow = { pk, sk: `CONSENT#${consentId}`, id: consentId, actor: member.subject, active: true, version: 1, recordedAt: utc(), details: 'Visible check-in; local sound analysis; review before sharing; no retained raw audio.' };
      await this.store.transact([check(member, { equals: { active: true } }), put(run), put(consentRow), ...grants.map(g => put(g)), put({ ...this.adminRun(run), pk: orgPK, sk: `RUN#${runId}` })]);
      this.bindings.set(runId, { pk, residentId: member.residentId, capability: randomBytes(32).toString('hex') });
      return run;
    });
  }
  adminRun(run) { return { id: run.id, version: run.version, alias: run.alias, residentId: run.residentId, state: run.state, agent_subject: run.agent_subject, createdAt: run.createdAt, leaseUntil: run.leaseUntil, expiresAt: run.expiresAt }; }
  async updateRun(run, changes) {
    const next = { ...run, ...changes, version: run.version + 1 };
    await this.store.transact([put(next, run.version), { kind: 'put', item: { ...this.adminRun(next), pk: orgPK, sk: `RUN#${run.id}` } }]);
    return next;
  }
  async heartbeat(principal, runId) {
    return this.locks.with(runId, async () => { const { run } = await this.ownedRun(principal, runId); return this.updateRun(run, { leaseUntil: this.clock() + 8000 }); });
  }
  async setAnalysis(principal, runId, analysis, detector) {
    if (!['voice', 'typed-only', 'unavailable'].includes(analysis) || !['active', 'unavailable', 'stopped'].includes(detector)) throw new CareError('EXECUTION_FAILED', 400);
    return this.locks.with(runId, async () => { const { run } = await this.ownedRun(principal, runId); return this.updateRun(run, { analysis, detector }); });
  }
  async stopRun(principal, runId) {
    const member = await this.member(principal);
    let run;
    await this.locks.with(runId, async () => {
      if (member.role === 'admin') {
        const summary = await this.store.get(orgPK, `RUN#${runId}`);
        if (summary) run = await this.store.get(residentPK(summary.residentId), `RUN#${runId}`);
      } else ({ run } = await this.ownedRun(principal, runId, false));
      if (!run) throw new CareError('RESIDENT_SCOPE_DENIED');
      if (run.state !== 'STOPPED') run = await this.updateRun(run, { state: 'STOPPING', leaseUntil: 0, detector: 'stopped', analysis: 'unavailable' });
    });
    // Admission is denied before waiting for voice/audio transport cleanup.
    await this.voiceStops.get(runId)?.();
    return this.locks.with(runId, async () => {
      run = await this.store.get(run.pk, run.sk);
      if (run.state !== 'STOPPED') run = await this.updateRun(run, { state: 'STOPPED', stoppedAt: utc() });
      this.bindings.delete(runId); this.voiceStops.delete(runId); return { state: run.state, run_id: runId };
    });
  }
  async expireLeases() {
    for (const [runId, binding] of this.bindings) {
      const run = await this.store.get(binding.pk, `RUN#${runId}`);
      if (run?.state === 'ACTIVE' && (run.leaseUntil <= this.clock() || run.expiresAt <= this.clock())) {
        const expired = await this.locks.with(runId, async () => {
          const current = await this.store.get(binding.pk, run.sk);
          if (current.state !== 'ACTIVE' || (current.leaseUntil > this.clock() && current.expiresAt > this.clock())) return false;
          await this.updateRun(current, { state: 'STOPPING', leaseUntil: 0 }); return true;
        });
        if (!expired) continue;
        await this.voiceStops.get(runId)?.();
        await this.locks.with(runId, async () => { const current = await this.store.get(binding.pk, run.sk); if (current.state === 'STOPPING') await this.updateRun(current, { state: 'STOPPED', detector: 'stopped', analysis: 'unavailable', stoppedAt: utc() }); });
        this.bindings.delete(runId); this.voiceStops.delete(runId);
      }
    }
  }
  async revoke(principal, runId, tool) {
    if ((await this.member(principal)).role !== 'admin' || !TOOL_NAMES.includes(tool)) throw new CareError('TOOL_NOT_ALLOWED');
    return this.locks.with(runId, async () => {
      const summary = await this.store.get(orgPK, `RUN#${runId}`);
      if (!summary) throw new CareError('RESIDENT_SCOPE_DENIED');
      const grant = await this.store.get(residentPK(summary.residentId), `GRANT#${runId}#${tool}`);
      if (!grant) throw new CareError('TOOL_NOT_ALLOWED');
      const updated = { ...grant, version: grant.version + 1, revokedAt: utc() };
      await this.store.transact([put(updated, grant.version)]);
      await this.audit(runId, tool, {}, 'REVOKED', 'GRANT_REVOKED', updated.version, false);
      return { tool, version: updated.version, revokedAt: updated.revokedAt, boundary: 'Revocation is committed. Already-started reads may have returned context; new requests are denied.' };
    });
  }
  async audit(runId, tool, args, status, reason = null, grantVersion = null, effectStarted = false) {
    const receipt = { pk: orgPK, sk: `AUDIT#${utc()}#${randomUUID()}`, id: id('act'), run_id: runId, tool, argument_hash: hash(args),
      status, decision: ['DENIED', 'REVOKED'].includes(status) ? 'DENY' : 'ALLOW', reason, grant_version: grantVersion, effect_started: effectStarted, createdAt: utc(), version: 1 };
    await this.store.put(receipt); return receipt;
  }
  async protectedState(runId, tool, token, capability) {
    await this.verifyMachine(token, tool);
    const binding = this.bindings.get(runId);
    if (!binding || typeof capability !== 'string' || capability.length !== binding.capability.length || !timingSafeEqual(Buffer.from(capability), Buffer.from(binding.capability))) throw new CareError('AUTH_INVALID');
    const run = await this.store.get(binding.pk, `RUN#${runId}`);
    if (!run || run.agent_subject !== this.machineClientId || run.state !== 'ACTIVE' || run.leaseUntil <= this.clock() || run.expiresAt <= this.clock()) throw new CareError('RUN_STOPPED');
    if (run.human_expires_at <= this.clock()) throw new CareError('AUTH_INVALID');
    const [login, member, grant, consent] = await Promise.all([
      run.login_jti ? this.store.get(orgPK, `LOGIN#${run.login_jti}`) : null,
      this.store.get(orgPK, `MEMBER#${run.actor}`),
      this.store.get(binding.pk, `GRANT#${runId}#${tool}`),
      this.store.get(binding.pk, `CONSENT#${run.consent_ref}`),
    ]);
    if (run.login_jti && (!login?.active || login.sub !== run.actor)) throw new CareError('AUTH_INVALID');
    if (!member?.active || member.residentId !== binding.residentId) throw new CareError('RESIDENT_SCOPE_DENIED');
    if (!grant || grant.revokedAt || grant.expiresAt <= this.clock()) throw new CareError('GRANT_REVOKED');
    if (grant.resource_scope !== binding.residentId) throw new CareError('RESIDENT_SCOPE_DENIED');
    if (!consent?.active || consent.actor !== run.actor) throw new CareError('CONFIRMATION_REQUIRED');
    return { run, member, grant, consent, binding, login };
  }
  async dispatch({ runId, tool, args, token, capability }) {
    return this.locks.with(runId, async () => {
      let state;
      try {
        if (!validators.has(tool)) throw new CareError('TOOL_NOT_ALLOWED');
        if (!validators.get(tool)(args)) throw new CareError('RESIDENT_SCOPE_DENIED', 400);
        state = await this.protectedState(runId, tool, token, capability);
        await this.audit(runId, tool, args, 'EXECUTING', null, state.grant.version, tool.startsWith('get_'));
        let result;
        if (tool === 'get_checkin_context') result = await this.context(state);
        if (tool === 'propose_follow_up') result = await this.propose(state, args);
        if (tool === 'create_review_task') result = await this.createTask(state, args);
        if (tool === 'get_review_status') {
          const task = await this.store.get(state.run.pk, `TASK#${args.task_id}`);
          if (!task) throw new CareError('RESIDENT_SCOPE_DENIED');
          result = { task_id: task.id, status: task.status, owner: task.owner_name, next_step: task.next_step || null, acknowledged_by: task.acknowledged_by || null };
        }
        await this.audit(runId, tool, args, 'SUCCEEDED', null, state.grant.version, true);
        return { ok: true, ...result };
      } catch (error) {
        const reason = error instanceof CareError ? error.code : error instanceof Conflict ? 'GRANT_REVOKED' : 'EXECUTION_FAILED';
        const uncertain = !(error instanceof CareError || error instanceof Conflict) && tool === 'create_review_task';
        await this.audit(runId, tool, args, uncertain ? 'UNKNOWN' : 'DENIED', reason, state?.grant.version, uncertain).catch(() => {});
        return { ok: false, code: reason, status: uncertain ? 'UNKNOWN' : 'DENIED', ...(uncertain ? { reconcile_request_id: args.request_id } : {}) };
      }
    });
  }
  async agentCall(runId, tool, args) {
    const token = await this.machineToken();
    return this.dispatch({ runId, tool, args, token, capability: this.bindings.get(runId)?.capability });
  }
  async context(state) {
    const { run } = state;
    const [record, initialIncident] = await Promise.all([this.store.get(run.pk, 'CONTEXT'), run.incidentId ? this.store.get(run.pk, `INCIDENT#${run.incidentId}`) : null]);
    let incident = initialIncident;
    let evidence = incident ? (await Promise.all(incident.evidence_ids.map(eid => this.store.get(run.pk, `EVIDENCE#${eid}`)))).filter(Boolean) : [];
    const stale = !record?.verified_at || this.clock() - Date.parse(record.verified_at) > 30 * 86400000;
    if (record && incident && !evidence.some(e => e.type === 'recorded')) {
      const recorded = { pk: run.pk, sk: `EVIDENCE#record_${incident.id}`, id: `record_${incident.id}`, type: 'recorded', version: 1,
        statement: stale ? 'Clinical context is stale; current conditions and medications are unknown.' : incident.topic === 'head-injury' ? `Recorded medication context: ${record.medications.join(', ') || 'unknown'}.` : incident.topic === 'cough' ? `Recorded condition context: ${record.conditions.join(', ') || 'unknown'}.` : 'Synthetic care-team assignment on file.',
        source_ref: record.source_ref, createdAt: utc(), effective_at: record.effective_at, verified_at: record.verified_at, verification: stale ? 'Stale: treat as unknown' : 'Synthetic record; not a patient statement', supports_ids: [] };
      const next = { ...incident, version: incident.version + 1, evidence_ids: [...incident.evidence_ids, recorded.id] };
      await this.store.transact([...this.guardChecks(state), put(recorded), put(next, incident.version)]);
      incident = next; evidence.push(recorded);
    }
    const awaitingControls = incident?.clarification_needed && incident.clarification_attempts >= 2;
    const dailyCheckin = dailyPlanContext(record);
    const questionMode = awaitingControls ? 'answer_controls' : !incident || ['dismissed', 'handed-off'].includes(incident.phase) ? (dailyCheckin.configured ? 'daily_checkin' : 'conversation') : 'approved_question';
    return { resident: record?.preferred_name || run.alias, daily_checkin: dailyCheckin, context: record ? { conditions: stale ? 'UNKNOWN: stale record' : record.conditions, medications: stale ? 'UNKNOWN: stale record' : record.medications,
      source: record.source, verified_at: record.verified_at, source_ref: record.source_ref, stale, synthetic: true } : { status: 'UNKNOWN: context unavailable' },
      incident: incident ? { id: incident.id, state: incident.state, phase: incident.phase, route: incident.route, protocol_version: PROTOCOL,
        clarification_needed: !!incident.clarification_needed, clarification_attempts: incident.clarification_attempts || 0, severe_breathing: incident.severe_breathing ?? null } : null,
      evidence: evidence.map(({ id, type, statement, source_ref, createdAt, verification, in_response_to }) => ({ id, type, statement, source_ref, createdAt, verification, in_response_to })),
      question_mode: questionMode, next_question: questionMode === 'approved_question' ? questionFor(incident) : null,
      checkin_status: incident ? questionFor(incident) : null,
      guidance: incident?.route === 'emergency' ? EMERGENCY : incident?.route === 'urgent' ? URGENT : null,
      instruction: (questionMode === 'answer_controls'
        ? 'The answer remains unconfirmed. Stop repeating or paraphrasing the clinical question. Once, offer the displayed Yes/No buttons or human help; then acknowledge and respond to the resident without restarting that question. Never infer an answer from silence or frustration. '
        : questionMode === 'daily_checkin' ? dailyCheckin.instruction + ' ' : questionMode === 'conversation' ? 'Respond naturally to what the resident just said. Do not repeatedly restart the daily check-in or ask questions already answered in conversation. '
        : 'Acknowledge the resident\'s answer, then use only the next approved clinical question. A denial of severe breathing difficulty does not deny discomfort or other symptoms. ')
        + 'Do not diagnose or recommend medication changes. A draft requires a separate human confirmation button. Tool failure is unknown context, never proof of absence.' };
  }
  guardChecks(state) {
    return [check(state.run, { equals: { state: 'ACTIVE' }, greater: { leaseUntil: this.clock(), expiresAt: this.clock() } }),
      check(state.grant, { equals: { revokedAt: null }, greater: { expiresAt: this.clock() } }), check(state.consent, { equals: { active: true } }), check(state.member, { equals: { active: true } }),
      ...(state.login ? [check(state.login, { equals: { active: true } })] : [])];
  }
  async propose(state, args) {
    const incident = await this.store.get(state.run.pk, `INCIDENT#${args.incident_id}`);
    if (!incident || incident.run_id !== state.run.id) throw new CareError('RESIDENT_SCOPE_DENIED');
    if (incident.state !== 'CONFIRMED_CONCERN' || !['ready', 'emergency'].includes(incident.phase)) throw new CareError('CONFIRMATION_REQUIRED');
    const existing = (await this.store.query(state.run.pk, 'DRAFT#')).find(d => d.incident_id === incident.id && d.valid && d.incident_version === incident.version);
    if (existing) return { draft: this.publicDraft(existing) };
    const resident = residents.find(r => r.id === state.run.residentId);
    const owner = incident.topic === 'pharmacy' && resident.assignedCaregiver ? resident.assignedCaregiver : resident.assignedNurse;
    const members = await this.store.query(orgPK, 'MEMBER#');
    const recipient = members.find(m => m.username === owner && m.active && m.assignments.includes(resident.id));
    if (!recipient) throw new CareError('CONTEXT_UNAVAILABLE');
    const evidence = (await Promise.all(incident.evidence_ids.map(eid => this.store.get(state.run.pk, `EVIDENCE#${eid}`)))).filter(Boolean);
    const statements = evidence.filter(e => e.type === 'reported' && !e.superseded).map(e => ({ id: e.id, quote: e.statement, at: e.createdAt, question: e.in_response_to || null }));
    const summary = { resident: state.run.alias, route: incident.route, reported: statements, recorded: evidence.filter(e => e.type === 'recorded').map(e => ({ statement: e.statement, source_ref: e.source_ref, verified_at: e.verified_at })), request: incident.topic === 'pharmacy' ? 'Help collecting medication; staff to review supply concerns.' : 'Please review the resident-confirmed concern and contact the resident.', recipient: recipient.name, protocol_version: PROTOCOL, synthetic: true };
    const draft = { pk: state.run.pk, sk: '', id: id('draft'), type: 'Draft', version: 1, incident_id: incident.id, incident_version: incident.version,
      run_id: state.run.id, valid: true, owner: recipient.subject, owner_name: recipient.name, summary, payload_hash: hash(summary), createdAt: utc(), request_id: id('request'),
      secondaryNurse: incident.topic === 'pharmacy' && incident.near_term_supply_concern ? members.find(m => m.username === resident.assignedNurse)?.subject : null };
    draft.sk = `DRAFT#${draft.id}`;
    await this.store.transact([...this.guardChecks(state), check(incident), put(draft)]);
    return { draft: this.publicDraft(draft) };
  }
  publicDraft(draft) { return { id: draft.id, incident_id: draft.incident_id, summary: draft.summary, recipient: draft.owner_name, valid: draft.valid, request_id: draft.request_id, payload_hash: draft.payload_hash }; }
  async confirm(principal, runId, draftId, accepted) {
    return this.locks.with(runId, async () => {
      const { run, member } = await this.ownedRun(principal, runId);
      const draft = await this.store.get(run.pk, `DRAFT#${draftId}`);
      const incident = draft && await this.store.get(run.pk, `INCIDENT#${draft.incident_id}`);
      if (!draft?.valid || draft.run_id !== runId || incident?.version !== draft.incident_version) throw new CareError('CONFIRMATION_REQUIRED');
      if (!accepted) { await this.store.transact([put({ ...draft, version: draft.version + 1, valid: false, declined_at: utc() }, draft.version)]); return { declined: true }; }
      const confirmation = { pk: run.pk, sk: '', id: id('confirmation'), type: 'Confirmation', version: 1, actor: member.subject, draft_id: draft.id, incident_id: incident.id,
        recipient_scope: draft.owner, payload_hash: draft.payload_hash, expiresAt: this.clock() + 120000, consumed_at: null, createdAt: utc() };
      confirmation.sk = `CONFIRMATION#${confirmation.id}`;
      await this.store.transact([check(run, { equals: { state: 'ACTIVE' }, greater: { leaseUntil: this.clock() } }), check(draft), check(incident), put(confirmation)]);
      return { confirmation_id: confirmation.id, request_id: draft.request_id, draft_id: draft.id };
    });
  }
  async createTask(state, args) {
    const { run } = state;
    const [draft, old] = await Promise.all([this.store.get(run.pk, `DRAFT#${args.draft_id}`), this.store.get(run.pk, `REQUEST#${args.request_id}`)]);
    if (!draft || draft.run_id !== run.id) throw new CareError('RESIDENT_SCOPE_DENIED');
    if (args.request_id !== draft.request_id) throw new CareError('CONFIRMATION_REQUIRED');
    if (old) return { task_id: old.task_id, status: 'CREATED', replayed: true };
    const [confirmation, incident, owner] = await Promise.all([this.store.get(run.pk, `CONFIRMATION#${args.confirmation_id}`), this.store.get(run.pk, `INCIDENT#${draft.incident_id}`), this.store.get(orgPK, `MEMBER#${draft.owner}`)]);
    if (!draft.valid || incident.version !== draft.incident_version || !confirmation || confirmation.actor !== run.actor || confirmation.draft_id !== draft.id || confirmation.recipient_scope !== draft.owner || confirmation.payload_hash !== draft.payload_hash || confirmation.consumed_at || confirmation.expiresAt <= this.clock()) throw new CareError('CONFIRMATION_REQUIRED');
    if (!owner?.active || !owner.assignments.includes(run.residentId)) throw new CareError('RESIDENT_SCOPE_DENIED');
    const task = { pk: run.pk, sk: '', id: id('task'), type: 'CareTask', version: 1, residentId: run.residentId, resident: run.alias, request_id: args.request_id,
      incident_id: incident.id, run_id: run.id, owner: owner.subject, owner_name: owner.name, status: 'CREATED', summary: draft.summary, evidence_ids: incident.evidence_ids,
      route: incident.route, protocol_version: PROTOCOL, createdAt: utc(), next_step: null, acknowledged_by: null };
    task.sk = `TASK#${task.id}`;
    const ops = [...this.guardChecks(state), { ...put({ ...draft, valid: false, version: draft.version + 1, submitted_at: utc() }, draft.version), equals: { valid: true } }, check(owner, { equals: { active: true } }),
      { ...put({ ...confirmation, version: confirmation.version + 1, consumed_at: utc() }, confirmation.version), equals: { consumed_at: null }, greater: { expiresAt: this.clock() } },
      put({ ...incident, version: incident.version + 1, state: 'FOLLOW_UP_OPEN', phase: 'handed-off' }, incident.version), put(task),
      put({ pk: run.pk, sk: `REQUEST#${args.request_id}`, version: 1, task_id: task.id, incident_id: incident.id })];
    if (draft.secondaryNurse && draft.secondaryNurse !== owner.subject) {
      const nurse = await this.store.get(orgPK, `MEMBER#${draft.secondaryNurse}`);
      if (!nurse?.active || !nurse.assignments.includes(run.residentId)) throw new CareError('RESIDENT_SCOPE_DENIED');
      const secondary = { ...task, id: id('task'), owner: nurse.subject, owner_name: nurse.name, route: 'clinical-review', related_task: task.id };
      secondary.sk = `TASK#${secondary.id}`;
      ops.push(check(nurse), put(secondary));
    }
    await this.store.transact(ops);
    return { task_id: task.id, status: 'CREATED', owner: owner.name };
  }
  async taskAction(principal, residentId, taskId, action, value = '') {
    const member = await this.member(principal);
    if (!['nurse', 'caregiver'].includes(member.role) || !member.assignments.includes(residentId)) throw new CareError('RESIDENT_SCOPE_DENIED');
    return this.locks.with(`task:${taskId}`, async () => {
      const task = await this.store.get(residentPK(residentId), `TASK#${taskId}`);
      if (!task || task.owner !== member.subject) throw new CareError('RESIDENT_SCOPE_DENIED');
      const next = { ...task, version: task.version + 1 };
      if (action === 'acknowledge' && task.status === 'CREATED') Object.assign(next, { status: 'ACKNOWLEDGED', acknowledged_by: member.name, acknowledged_subject: member.subject, acknowledged_at: utc() });
      else if (action === 'next-step' && ['ACKNOWLEDGED', 'NEXT_STEP_RECORDED'].includes(task.status) && typeof value === 'string' && value.trim().length > 0 && value.length <= 500) Object.assign(next, { status: 'NEXT_STEP_RECORDED', next_step: { text: value.trim(), actor: member.name, recorded_at: utc() } });
      else if (action === 'resolve' && ['ACKNOWLEDGED', 'NEXT_STEP_RECORDED'].includes(task.status) && member.role === 'nurse') Object.assign(next, { status: 'RESOLVED', resolved_by: member.name, resolved_at: utc() });
      else throw new CareError('EXECUTION_FAILED', 409);
      const ops = [check(member, { equals: { active: true } }), put(next, task.version)];
      if (action === 'resolve') {
        const others = (await this.store.query(task.pk, 'TASK#')).filter(t => t.incident_id === task.incident_id && t.id !== task.id && t.status !== 'RESOLVED');
        if (!others.length) { const incident = await this.store.get(task.pk, `INCIDENT#${task.incident_id}`); ops.push(put({ ...incident, version: incident.version + 1, state: 'CLOSED_BY_STAFF', resolved_by: member.name }, incident.version)); }
      }
      await this.store.transact(ops); return next;
    });
  }
}
