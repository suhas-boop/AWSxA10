import { randomUUID, createHash } from 'node:crypto';
import { CareService, CareError } from './service.mjs';
import { orgPK, residentPK, residents } from './fixtures.mjs';
import { PROTOCOL, advance, detectTopic, explicitEmergency, questionFor, EMERGENCY, URGENT } from './rules.mjs';
import { findingsForAnswer } from './checkin-progress.mjs';
import acoustic from '../../config/acoustic.json' with { type: 'json' };
import { hasHeartFailureDemo, heartFailureFindings, heartFailureRoute, weightChange } from './heart-failure.mjs';
const id = prefix => `${prefix}_${randomUUID()}`;
const utc = () => new Date().toISOString();

export class CareWorkflow extends CareService {
  evidence(run, type, statement, source, extra = {}) {
    const eid = id('ev');
    return { pk: run.pk, sk: `EVIDENCE#${eid}`, id: eid, type, run_id: run.id, residentId: run.residentId, version: 1, statement, source_ref: source,
      createdAt: utc(), verification: type === 'observed' ? 'Source and speaker unconfirmed' : 'Resident statement; not independently measured', supports_ids: [], ...extra };
  }
  incident(run, topic, evidence) {
    const iid = id('incident');
    return { pk: run.pk, sk: `INCIDENT#${iid}`, id: iid, type: 'Incident', run_id: run.id, residentId: run.residentId, version: 1, topic, createdAt: utc(),
      evidence_ids: [evidence.id], protocol_version: PROTOCOL, state: evidence.type === 'observed' ? 'OBSERVATION_PENDING' : 'CLARIFYING', route: 'clarify',
      phase: topic === 'head-injury' ? 'head-confirm' : topic === 'pharmacy' ? 'pickup' : evidence.type === 'reported' ? 'new' : 'source',
      symptom_confirmed: evidence.type === 'reported' && topic === 'cough', candidate_count: evidence.type === 'observed' ? 1 : 0, last_candidate_ms: 0 };
  }
  async observe(principal, runId, observation) {
    return this.locks.with(runId, async () => {
      const { run } = await this.ownedRun(principal, runId);
      const elapsed = this.clock() - Date.parse(run.createdAt);
      if (observation.end_ms > elapsed + 5000 || observation.start_ms < 0 || observation.end_ms <= observation.start_ms || observation.end_ms - observation.start_ms > 2000 || observation.score < acoustic.threshold || observation.score > 1 || !['Cough', 'Throat clearing'].includes(observation.label)) throw new CareError('EXECUTION_FAILED', 400);
      const windowKey = createHash('sha256').update(`${runId}:${observation.window_id}`).digest('hex');
      if (await this.store.get(run.pk, `OBS_WINDOW#${windowKey}`)) return { duplicate: true };
      const windowRow = { pk: run.pk, sk: `OBS_WINDOW#${windowKey}`, version: 1, run_id: runId, start_ms: observation.start_ms, end_ms: observation.end_ms };
      let incident = run.incidentId ? await this.store.get(run.pk, `INCIDENT#${run.incidentId}`) : null;
      const evidence = this.evidence(run, 'observed', `Possible ${observation.label.toLowerCase()}-like sound.`, 'browser:YAMNet:float32:1', {
        start_ms: observation.start_ms, end_ms: observation.end_ms, detector_score: observation.score, quality: observation.quality,
        label: observation.label, clinical_probability: false, untrusted_browser_event: true,
      });
      const ops = [{ kind: 'put', item: windowRow, expectedVersion: null }];
      if (observation.label === 'Throat clearing') { ops.push({ kind: 'put', item: evidence, expectedVersion: null }); await this.store.transact(ops); return { recorded: true, follow_up: false }; }
      const recentlyDismissed = incident?.state === 'DISMISSED_BY_USER' && observation.end_ms - incident.last_candidate_ms < 20000;
      if (!incident || (['CLOSED_BY_STAFF', 'DISMISSED_BY_USER'].includes(incident.state) && !recentlyDismissed)) {
        incident = this.incident(run, 'cough', evidence); incident.last_candidate_ms = observation.end_ms;
        ops.push({ kind: 'put', item: evidence, expectedVersion: null }, { kind: 'put', item: incident, expectedVersion: null });
        const nextRun = { ...run, version: run.version + 1, incidentId: incident.id };
        ops.push({ kind: 'put', item: nextRun, expectedVersion: run.version });
      } else if (incident.topic === 'cough') {
        // Count every candidate window, but merge overlapping detections into one evidence event.
        const overlap = observation.start_ms <= incident.last_candidate_ms + 300;
        const next = { ...incident, version: incident.version + 1, candidate_count: incident.candidate_count + 1, last_candidate_ms: observation.end_ms };
        if (!overlap) { next.evidence_ids = [...incident.evidence_ids, evidence.id]; ops.push({ kind: 'put', item: evidence, expectedVersion: null }); }
        ops.push({ kind: 'put', item: next, expectedVersion: incident.version }); incident = next;
      } else ops.push({ kind: 'put', item: evidence, expectedVersion: null });
      await this.store.transact(ops);
      return { observed: true, incident_id: incident.id, question: questionFor(incident), candidate_count: incident.candidate_count };
    });
  }
  async report(principal, runId, text, source = 'typed', turnId = id('turn'), speechPrefix = '', spokenQuestion = null) {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new CareError('EXECUTION_FAILED', 400);
    const { run } = await this.ownedRun(principal, runId);
    const record = await this.store.get(run.pk, 'CONTEXT');
    if (!hasHeartFailureDemo(record) || ['head-injury', 'pharmacy'].includes(detectTopic(text))) return this.reportGeneral(principal, runId, text, source, turnId);
    const prefix = source === 'speech' && typeof speechPrefix === 'string' ? speechPrefix.slice(-4000) : '';
    const result = await this.reportHeartFailure(principal, runId, text, source, turnId, record, prefix, source === 'speech' ? spokenQuestion : null);
    if (result.general) return this.reportGeneral(principal, runId, text, source, turnId);
    if (!result.duplicate && result.incident && result.incident.route !== 'clarify' && (result.evidence_saved !== false || result.incident.alert_pending)) {
      // Execute the same permission-checked tool used by the model. Only this explicit,
      // synthetic care plan permits automatic simulated notification; never a real call.
      try { result.alert = await this.agentCall(runId, 'propose_follow_up', { incident_id: result.incident.id, assistance: 'Execute the authorized simulated care-plan alert.' }); }
      catch { result.alert = { ok: false, status: 'UNKNOWN', code: 'EXECUTION_FAILED' }; }
    }
    return result;
  }
  async reportHeartFailure(principal, runId, text, source, turnId, record, speechPrefix, spokenQuestion) {
    return this.locks.with(runId, async () => {
      const { run } = await this.ownedRun(principal, runId);
      const key = createHash('sha256').update(`${runId}:${turnId}`).digest('hex');
      const old = run.incidentId ? await this.store.get(run.pk, `INCIDENT#${run.incidentId}`) : null;
      if (await this.store.get(run.pk, `TURN#${key}`)) return { duplicate: true, incident: old?.topic === 'heart-failure' ? old : null };
      if (old && !['cough', 'heart-failure'].includes(old.topic)) return { general: true };
      const spokenContext = speechPrefix ? `${speechPrefix} ${text}` : text;
      let found = { ...findingsForAnswer(text, spokenQuestion), ...heartFailureFindings(spokenContext, old?.findings) };
      if (old?.topic === 'cough' && old.phase === 'source' && /^(yes|yeah|yep|it was me|that was me)\b/i.test(text)) found = { ...found, cough: true };
      const change = weightChange(record, this.clock());
      if (old?.topic === 'cough' && !Object.keys(found).length && !(change?.increase_lb > 3)) return { general: true };
      const marker = { kind: 'put', item: { pk: run.pk, sk: `TURN#${key}`, version: 1 }, expectedVersion: null };
      if (!old && !Object.keys(found).length && !(change?.increase_lb > 3)) { await this.store.transact([marker]); return { evidence_saved: false }; }
      // Acknowledgments and social chat do not create a new clinical revision or
      // resend the same handoff. Keep the existing findings and delivery receipt.
      if (old?.topic === 'heart-failure' && !Object.keys(found).length && !/cough|breath|pillows?|ankles?|swelling|weight|pounds|\blb\b|chest|tired/i.test(text) && !(change?.increase_lb > 3)) {
        await this.store.transact([marker]); return { incident: old, evidence_saved: false };
      }
      const evidence = this.evidence(run, 'reported', text.trim(), `${source}:final:${turnId}`, {
        finding_keys: Object.keys(found), utterance_context: speechPrefix ? spokenContext : null,
        in_response_to: spokenQuestion?.question || null,
        question_turn_ids: spokenQuestion?.assistant_turn_ids || [],
        context_provenance: speechPrefix ? 'Consecutive final resident speech blocks from this same authenticated voice session; current segment preserved in statement' : null,
        clinical_relevance: Object.keys(found).length > 0 || /cough|breath|pillows?|ankles?|swelling|weight|pounds|\blb\b|chest|tired/i.test(text),
      });
      const findings = { ...(old?.findings || {}), ...found };
      const route = heartFailureRoute(findings, change);
      const incident = { ...(old || this.incident(run, 'heart-failure', evidence)), topic: 'heart-failure', findings,
        version: old ? old.version + 1 : 1, evidence_ids: [...(old?.evidence_ids || []), evidence.id], protocol_version: record.demo_care_plan.id,
        route, phase: route === 'emergency' ? 'emergency' : 'monitoring', state: route === 'clarify' ? 'CLARIFYING' : 'CONFIRMED_CONCERN',
        symptom_confirmed: Object.values(findings).some(Boolean), alert_pending: route !== 'clarify', alert_receipt: null };
      const ops = [marker, { kind: 'put', item: evidence, expectedVersion: null }, { kind: 'put', item: incident, expectedVersion: old?.version ?? null }];
      if (!old) ops.push({ kind: 'put', item: { ...run, version: run.version + 1, incidentId: incident.id }, expectedVersion: run.version });
      await this.store.transact(ops);
      return { incident, emergency: route === 'emergency' ? EMERGENCY : null };
    });
  }
  async reportGeneral(principal, runId, text, source = 'typed', turnId = id('turn')) {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new CareError('EXECUTION_FAILED', 400);
    return this.locks.with(runId, async () => {
      const { run } = await this.ownedRun(principal, runId);
      const turnKey = createHash('sha256').update(`${runId}:${turnId}`).digest('hex');
      if (await this.store.get(run.pk, `TURN#${turnKey}`)) return { duplicate: true };
      let incident = run.incidentId ? await this.store.get(run.pk, `INCIDENT#${run.incidentId}`) : null;
      const emergency = explicitEmergency(text);
      const topic = detectTopic(text);
      const evidence = this.evidence(run, 'reported', text.trim(), `${source}:final:${turnId}`, { in_response_to: incident ? questionFor(incident) : null });
      const ops = [{ kind: 'put', item: { pk: run.pk, sk: `TURN#${turnKey}`, version: 1 }, expectedVersion: null }];
      if (!incident || ['DISMISSED_BY_USER', 'CLOSED_BY_STAFF'].includes(incident.state)) {
        if (!topic && !emergency) { await this.store.transact(ops); return { question: 'How has your day been?', evidence_saved: false }; }
        incident = this.incident(run, topic || 'breathing', evidence);
        if (emergency) Object.assign(incident, { phase: 'emergency', route: 'emergency', state: 'CONFIRMED_CONCERN' });
        ops.push({ kind: 'put', item: evidence, expectedVersion: null }, { kind: 'put', item: incident, expectedVersion: null },
          { kind: 'put', item: { ...run, version: run.version + 1, incidentId: incident.id }, expectedVersion: run.version });
      } else {
        if (incident.phase === 'handed-off' && !emergency) { await this.store.transact(ops); return { question: questionFor(incident) }; }
        const next = { ...advance(incident, text), version: incident.version + 1, evidence_ids: [...incident.evidence_ids, evidence.id] };
        ops.push({ kind: 'put', item: evidence, expectedVersion: null }, { kind: 'put', item: next, expectedVersion: incident.version });
        if (next.phase === 'ready' || next.phase === 'emergency') {
          const inferred = this.evidence(run, 'inferred', `Demonstration pathway: ${next.route}. This is routing, not a diagnosis.`, PROTOCOL, { verification: 'Unreviewed demonstration rule', supports_ids: next.evidence_ids });
          next.evidence_ids = [...next.evidence_ids, inferred.id]; ops.push({ kind: 'put', item: inferred, expectedVersion: null });
        }
        incident = next;
      }
      await this.store.transact(ops);
      return { question: questionFor(incident), incident, emergency: incident.route === 'emergency' ? EMERGENCY : null };
    });
  }
  async correct(principal, runId, evidenceId, text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new CareError('EXECUTION_FAILED', 400);
    return this.locks.with(runId, async () => {
      const { run } = await this.ownedRun(principal, runId);
      const old = await this.store.get(run.pk, `EVIDENCE#${evidenceId}`);
      const incident = run.incidentId && await this.store.get(run.pk, `INCIDENT#${run.incidentId}`);
      if (!old || old.type !== 'reported' || !incident?.evidence_ids.includes(old.id)) throw new CareError('RESIDENT_SCOPE_DENIED');
      const correction = this.evidence(run, 'reported', text, `resident-correction:${old.id}`, { corrects_id: old.id });
      const next = { ...incident, version: incident.version + 1, state: 'CLARIFYING', phase: incident.topic === 'cough' ? 'new' : incident.topic === 'head-injury' ? 'head-confirm' : 'pickup', route: 'clarify', evidence_ids: [...incident.evidence_ids, correction.id] };
      if (incident.topic === 'heart-failure') {
        const record = await this.store.get(run.pk, 'CONTEXT');
        const rows = (await Promise.all(incident.evidence_ids.map(eid => this.store.get(run.pk, `EVIDENCE#${eid}`)))).filter(e => e?.type === 'reported' && !e.superseded && e.id !== old.id);
        let findings = {};
        for (const row of [...rows, correction]) findings = { ...findings, ...heartFailureFindings(row.statement, findings) };
        correction.finding_keys = Object.keys(heartFailureFindings(text)); correction.clinical_relevance = true;
        const route = heartFailureRoute(findings, weightChange(record, this.clock()));
        Object.assign(next, { findings, route, phase: route === 'emergency' ? 'emergency' : 'monitoring', state: route === 'clarify' ? 'CLARIFYING' : 'CONFIRMED_CONCERN', alert_receipt: null, alert_pending: route !== 'clarify' });
      }
      const drafts = (await this.store.query(run.pk, 'DRAFT#')).filter(d => d.incident_id === incident.id && d.valid);
      const tasks = (await this.store.query(run.pk, 'TASK#')).filter(t => t.incident_id === incident.id && t.status !== 'RESOLVED');
      await this.store.transact([{ kind: 'put', item: { ...old, version: old.version + 1, superseded: true }, expectedVersion: old.version },
        { kind: 'put', item: correction, expectedVersion: null }, { kind: 'put', item: next, expectedVersion: incident.version },
        ...drafts.map(d => ({ kind: 'put', item: { ...d, version: d.version + 1, valid: false }, expectedVersion: d.version })),
        ...tasks.map(t => ({ kind: 'put', item: { ...t, version: t.version + 1, correction_pending: true, evidence_ids: next.evidence_ids }, expectedVersion: t.version }))]);
      return { corrected: true, question: questionFor(next), existing_tasks_preserved: tasks.length };
    });
  }
  async snapshot(principal) {
    const member = await this.member(principal);
    const actor = { name: member.name, role: member.role, username: member.username, residentId: member.residentId };
    if (member.role === 'admin') {
      const runs = (await this.store.query(orgPK, 'RUN#')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const grants = (await Promise.all(runs.slice(0, 20).map(r => this.store.query(residentPK(r.residentId), `GRANT#${r.id}#`)))).flat();
      const receipts = (await this.store.query(orgPK, 'AUDIT#')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
      return { actor, runs: runs.slice(0, 20), grants, receipts, synthetic: true, boundary: 'Gateway enforcement. No process-isolation or Harness claim.' };
    }
    if (member.role === 'resident') {
      const rows = await this.store.query(residentPK(member.residentId));
      actor.name = rows.find(r => r.sk === 'CONTEXT')?.preferred_name || actor.name;
      const runs = rows.filter(r => r.type === 'AgentRun' && r.actor === member.subject).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const run = runs[0] || null;
      const incident = run ? rows.find(r => r.sk === `INCIDENT#${run.incidentId}`) : null;
      const evidence = incident ? rows.filter(e => e.sk.startsWith('EVIDENCE#') && incident.evidence_ids.includes(e.id) && e.type !== 'recorded').sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];
      const drafts = incident ? rows.filter(d => d.type === 'Draft' && d.incident_id === incident.id && d.valid && d.incident_version === incident.version).map(d => this.publicDraft(d)) : [];
      const tasks = rows.filter(t => t.type === 'CareTask').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { actor, run: run && { id: run.id, workflow: run.workflow || 'clinical', state: run.state, leaseUntil: run.leaseUntil, detector: run.detector, analysis: run.analysis },
        incident, evidence, drafts, tasks, question: questionFor(incident), emergency: incident?.route === 'emergency' ? EMERGENCY : null,
        synthetic: true, human_help: 'Contact the community care desk directly. This prototype does not place calls.' };
    }
    if (['nurse', 'caregiver'].includes(member.role)) {
      const groups = await Promise.all(member.assignments.map(rid => this.store.query(residentPK(rid))));
      const tasks = groups.flat().filter(t => t.type === 'CareTask' && t.owner === member.subject).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const evidenceIds = new Set(tasks.flatMap(t => t.evidence_ids));
      const incidentIds = new Set(tasks.map(t => t.incident_id));
      return { actor, tasks, evidence: groups.flat().filter(e => e.sk.startsWith('EVIDENCE#') && evidenceIds.has(e.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        incidents: groups.flat().filter(i => i.type === 'Incident' && incidentIds.has(i.id)), synthetic: true };
    }
    throw new CareError('AUTH_INVALID');
  }
  async reconcile(principal, requestId) {
    const member = await this.residentMember(principal);
    const receipt = await this.store.get(residentPK(member.residentId), `REQUEST#${requestId}`);
    return receipt ? { status: 'CREATED', task_id: receipt.task_id } : { status: 'UNKNOWN', request_id: requestId };
  }
}
