import { SonicSession } from '../session.mjs';
import { createTransport } from '../bedrock.mjs';
import { companionTools, COMPANION_PROMPT } from './companion-tools.mjs';

export async function createCompanionVoice({ portal, run, emit, region }) {
  const transport = createTransport({ region, modelId: 'amazon.nova-2-sonic-v1:0' });
  const calls = new Map(), announced = new Set(); let session, polling = false, stopped = false;
  const runner = {
    specs: () => companionTools.map(t => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: JSON.stringify(t.schema) } } })),
    execute(call) {
      if (!calls.has(call.toolUseId)) calls.set(call.toolUseId, (async () => {
        try { return await portal.call(run.id, call.toolName, JSON.parse(call.content)); }
        catch { return { ok: false, code: 'EXECUTION_FAILED', status: 'UNKNOWN' }; }
      })());
      return calls.get(call.toolUseId);
    }, cancel() {},
  };
  session = new SonicSession({ transport, runner, emit, systemPrompt: COMPANION_PROMPT,
    initialPrompt: 'Application event, not resident speech: the resident started their everyday companion. Read get_companion_context and greet them warmly with one casual question.',
    hardRenewMs: 450000,
    diagnose: process.env.CAREALONG_VOICE_TRACE === '1' ? value => console.log(JSON.stringify({ companionTrace: true, ...value })) : undefined,
    onFinalTurn: async turn => {
      const parts = [];
      for (let i = session.history.length - 1; i >= 0 && session.history[i].role === 'USER' && parts.length < 4; i--) parts.unshift(session.history[i].text);
      await portal.recordSpeech(run.id, turn.text, parts.join(' '));
    },
  });
  let tracedAt = 0;
  const timer = setInterval(async () => {
    if (process.env.CAREALONG_VOICE_TRACE === '1' && Date.now() - tracedAt > 10000) { tracedAt = Date.now(); console.log(JSON.stringify({ companionTrace: true, event: 'notification-state', busy: session.connection?.busy, blocks: [...(session.connection?.blocks.values() || [])].map(b => ({ role: b.role, type: b.type })), pendingTools: session.connection?.pendingTools.size })); }
    if (polling || stopped || !session.canNotify()) return;
    polling = true;
    try {
      const state = await portal.socialState(run.id);
      if (state.policy.paused || !state.policy.capabilities.help || !state.consent.capabilities.help) return;
      const requests = await portal.store.query(run.pk, 'SOCIAL_REQUEST#');
      for (const request of requests.filter(r => r.run_id === run.id && r.reply && !announced.has(r.reply.id))) {
        await portal.store.transact(portal.guards(state));
        if (session.notify(`Application event, not resident speech: an assigned staff member saved an update for request ${request.id}. Fetch get_request_status with that request_id. Only relay the stored reply after authorization succeeds. Update reference ${request.reply.id}.`)) announced.add(request.reply.id);
        break;
      }
    } catch (error) { if (process.env.CAREALONG_VOICE_TRACE === '1') console.log(JSON.stringify({ companionTrace: true, event: 'notification-check-failed', code: error.code || error.name })); }
    finally { polling = false; }
  }, 1500);
  return { session, async stop() { if (stopped) return; stopped = true; clearInterval(timer); portal.speech.delete(run.id); await session.stop(); transport.destroy(); } };
}
