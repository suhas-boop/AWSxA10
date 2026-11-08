import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AudioSession } from './audio.mjs';
import { SoundDetector } from './detector.mjs';
import './care.css';

type RecordData = Record<string, any>;
type Snapshot = { actor: RecordData; run?: RecordData; incident?: RecordData; evidence?: RecordData[]; tasks?: RecordData[]; drafts?: RecordData[]; question?: string; emergency?: string; runs?: RecordData[]; grants?: RecordData[]; receipts?: RecordData[] };
type Turn = { id: string; role: string; text: string; final: boolean };
const time = (value?: string) => value ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';
const statusLabel = (value: string) => ({ CREATED: 'Awaiting acknowledgment', ACKNOWLEDGED: 'Acknowledged', NEXT_STEP_RECORDED: 'Next step recorded', RESOLVED: 'Resolved', ACTIVE: 'Active', STOPPING: 'Stopping', STOPPED: 'Stopped' }[value] || value?.replaceAll('_', ' ').toLowerCase());
function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    mic: <><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0014 0v-2M12 19v3M8 22h8"/></>,
    leaf: <><path d="M19 4C8 2 2 9 6 15s15 2 13-11Z"/><path d="m5 20 9-11"/></>,
    heart: <path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 00-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 000-7.8Z"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></>,
    message: <path d="M21 11a8 8 0 01-8 8H6l-4 3V10a8 8 0 018-8h3a8 8 0 018 9Z"/>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
  };
  return <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name] || paths.heart}</svg>;
}

function App() {
  const [token, setToken] = useState<string>(() => sessionStorage.getItem('carealong-session') || '');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [config, setConfig] = useState<RecordData | null>(null);
  const [username, setUsername] = useState('margaret'), [password, setPassword] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('idle'), [detector, setDetector] = useState('unavailable');
  const [turns, setTurns] = useState<Turn[]>([]), [typed, setTyped] = useState('');
  const captionPanel = useRef<HTMLDivElement>(null);
  const [followCaptions, setFollowCaptions] = useState(true);
  const [consent, setConsent] = useState(false), [help, setHelp] = useState(false);
  const [selectedRun, setSelectedRun] = useState(''), [nextSteps, setNextSteps] = useState<Record<string, string>>({});
  const [correction, setCorrection] = useState<RecordData | null>(null), [correctionText, setCorrectionText] = useState('');
  const resources = useRef<RecordData>({}), stateRef = useRef<Snapshot | null>(null), tokenRef = useRef(token);
  tokenRef.current = token; stateRef.current = snapshot;
  const active = ['starting', 'listening', 'speaking', 'typed', 'renewing'].includes(phase);
  const role = snapshot?.actor.role;
  useLayoutEffect(() => {
    const panel = captionPanel.current;
    if (followCaptions && panel) panel.scrollTop = panel.scrollHeight;
  }, [turns, followCaptions]);

  async function api(path: string, body?: RecordData, currentToken = tokenRef.current) {
    const response = await fetch(`/api${path}`, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', ...(currentToken ? { Authorization: `Bearer ${currentToken}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json();
    if (!response.ok) throw new Error(value.code === 'AUTH_INVALID' ? 'Your sign-in has expired or the credentials were not accepted.' : value.code || 'The request could not be completed.');
    return value;
  }
  async function refresh() { const state = await api('/state'); setSnapshot(state); return state; }
  useEffect(() => { fetch('/api/config').then(r => r.json()).then(setConfig).catch(() => setError('CareAlong is not connected. Start the backend and refresh.')); }, []);
  useEffect(() => {
    if (!token) return;
    const abort = new AbortController(); let retry: ReturnType<typeof setTimeout>;
    async function subscribe() {
      try {
        const response = await fetch('/api/events', { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal });
        if (!response.ok || !response.body) throw new Error('Please sign in again.');
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        while (!abort.signal.aborted) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            if (event.includes('event: auth-error')) throw new Error('Your sign-in is no longer active.');
            const data = event.split('\n').find(line => line.startsWith('data: '));
            if (data) setSnapshot(JSON.parse(data.slice(6)));
          }
        }
        if (!abort.signal.aborted) retry = setTimeout(subscribe, 2000);
      } catch (e: any) { if (!abort.signal.aborted) { setNotice('Live updates are interrupted. Reconnecting…'); retry = setTimeout(subscribe, 3000); } }
    }
    void refresh().catch((e: Error) => setError(e.message)); void subscribe();
    return () => { abort.abort(); clearTimeout(retry); };
  }, [token]);
  useEffect(() => () => { resources.current.detector?.stop(); void resources.current.audio?.stop(); resources.current.ws?.close(); clearInterval(resources.current.heartbeat); }, []);
  useEffect(() => {
    if (!help && !correction) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const controls = () => [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select, [tabindex="0"]') || [])];
    controls()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setHelp(false); setCorrection(null); }
      if (event.key !== 'Tab') return;
      const items = controls(), first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [help, correction]);

  async function login(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await api('/login', { username, password }, ''); sessionStorage.setItem('carealong-session', result.token); setToken(result.token); setPassword(''); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function logout() {
    if (resources.current.runId) await stop();
    await api('/logout', {}).catch(() => {}); sessionStorage.removeItem('carealong-session'); setToken(''); setSnapshot(null); setPhase('idle');
  }
  async function action(fn: () => Promise<unknown>) {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); await refresh(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function stop() {
    const r = resources.current; r.cancelled = true; setPhase('stopping'); r.accepting = false; clearInterval(r.heartbeat);
    r.detector?.stop(); setDetector('stopped'); await r.audio?.stop();
    try {
      if (r.runId) await api(`/runs/${r.runId}/stop`, {});
      r.ws?.close(); r.runId = null; setPhase('stopped'); await refresh();
    } catch { r.ws?.close(); setError('Local listening is off. Waiting to confirm the server has stopped; new actions expire within 10 seconds without a heartbeat.'); }
  }
  async function start(mode: 'voice' | 'typed') {
    if (!consent) return;
    setBusy(true); setError(''); setNotice(''); setTurns([]); setFollowCaptions(true); setPhase('starting');
    const r: RecordData = { accepting: false }; resources.current = r;
    try {
      const run = await api('/runs', { consent: true }); r.runId = run.id;
      if (r.cancelled || resources.current !== r) { await api(`/runs/${run.id}/stop`, {}); r.runId = null; setPhase('stopped'); return; }
      r.heartbeat = setInterval(() => { void api(`/runs/${run.id}/heartbeat`, {}).catch(() => { clearInterval(r.heartbeat); r.accepting = false; r.detector?.stop(); void r.audio?.stop(); r.ws?.close(); setPhase('stopping'); setError('The connection was lost. Local listening is off; server actions expire within 10 seconds.'); }); }, 2000);
      if (mode === 'typed') { setPhase('typed'); await api(`/runs/${run.id}/analysis`, { analysis: 'typed-only', detector: 'unavailable' }); await refresh(); return; }
      r.detector = new SoundDetector((observation: RecordData) => {
        if (r.runId) void api(`/runs/${r.runId}/observations`, observation).catch(() => setNotice('A sound observation could not be recorded. Please tell us about any concern directly.'));
      }, (value: string) => {
        setDetector(value);
        if (r.runId) void api(`/runs/${r.runId}/analysis`, { analysis: 'voice', detector: value }).catch(() => {});
      });
      r.audio = new AudioSession((frame: ArrayBuffer) => {
        r.detector?.frame(frame, Date.now() - Date.parse(run.createdAt));
        if (r.accepting && r.ws?.readyState === WebSocket.OPEN) {
          if (r.ws.bufferedAmount > 128000) { void stop(); setError('Audio is delayed. Please start a fresh session.'); return; }
          r.ws.send(frame);
        }
      }, (playing: boolean) => setPhase(value => ['listening', 'speaking'].includes(value) ? (playing ? 'speaking' : 'listening') : value));
      await r.audio.start();
      if (resources.current !== r || !r.runId || r.cancelled) { await r.audio.stop(); return; }
      void r.detector.start().catch(() => setDetector('unavailable'));
      const url = new URL('/ws', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('run', run.id);
      const encoded = btoa(token).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      r.ws = new WebSocket(url, [`carealong-token.${encoded}`, 'carealong']);
      r.ws.onmessage = ({ data }: MessageEvent) => {
        const message = JSON.parse(data);
        if (message.type === 'status') {
          if (message.status === 'listening') { r.accepting = true; setPhase('listening'); }
          if (message.status === 'renewing') { r.accepting = false; r.audio.clear(); setPhase('renewing'); }
          if (message.status === 'ended') { r.accepting = false; r.audio.clear(); }
        }
        if (message.type === 'audio') r.audio.play(message.data);
        if (message.type === 'interrupt') r.audio.clear();
        if (message.type === 'transcript') setTurns(rows => [...rows.filter(t => t.id !== message.id), message].slice(-100));
        if (message.type === 'error') { setError(message.message); void stop(); }
      };
      r.ws.onerror = () => { setError('Voice could not connect. End this session, then use typed support or contact your care team.'); void stop(); };
      r.ws.onclose = () => { r.accepting = false; r.detector?.stop(); void r.audio?.stop(); clearInterval(r.heartbeat); if (r.runId) { setPhase('stopping'); void api(`/runs/${r.runId}/stop`, {}).then(() => { r.runId = null; setPhase('stopped'); }).catch(() => {}); } };
      await refresh();
    } catch (e: any) { setError(e.name === 'NotAllowedError' ? 'Microphone access was not allowed. You can use typed support.' : e.message); await stop(); }
    finally { setBusy(false); }
  }
  async function sendText(value: string) {
    const runId = resources.current.runId || snapshot?.run?.id;
    if (!runId || !value.trim()) return;
    const turnId = crypto.randomUUID(); setTyped('');
    await action(async () => {
      const result = await api(`/runs/${runId}/turns`, { text: value.trim(), turn_id: turnId });
      setTurns(rows => [...rows, { id: turnId, role: 'USER', text: value.trim(), final: true }]);
      if (result.emergency) setNotice(result.emergency);
      // A typed response is labeled as typed; it is never injected as a detected sound.
    });
  }
  async function reconnectVoice() {
    const r = resources.current;
    if (r.reconnecting || r.ws?.readyState !== WebSocket.OPEN) { setError('Please stop and start a new voice check-in.'); return; }
    r.reconnecting = true; setError('');
    try {
      await r.audio.resume(); r.audio.clear();
      r.ws.send(JSON.stringify({ type: 'reconnect' }));
      setNotice('Reconnecting voice. Your care requests are preserved. Please repeat the last sentence when Listening returns.');
    } catch (e: any) { setError(e.message); }
    finally { r.reconnecting = false; }
  }
  async function confirmDraft(draft: RecordData, accepted: boolean) {
    await action(async () => {
      try {
        const result = await api(`/runs/${snapshot?.run?.id}/confirm`, { draft_id: draft.id, accepted });
        if (result.status === 'UNKNOWN') setNotice(`Request status is unknown. Reference ${draft.request_id}. Use Check request status before retrying.`);
        else if (result.ok === false) throw new Error(result.code);
      } catch (e) {
        const reconciled = await api(`/requests/${draft.request_id}`).catch(() => ({ status: 'UNKNOWN' }));
        if (reconciled.status !== 'CREATED') throw e;
        setNotice('Your original request was found. No duplicate was created.');
      }
    });
  }

  const selected = snapshot?.runs?.find(r => r.id === selectedRun) || snapshot?.runs?.[0];
  const grants = snapshot?.grants?.filter(g => g.run_id === selected?.id) || [];
  const primaryTask = snapshot?.tasks?.find(task => task.run_id === snapshot?.run?.id);
  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';
  return <div className={`care-app ${role === 'resident' ? 'senior-mode' : ''}`}>
    <header className="care-header"><a href="/" className="care-logo"><span><Icon name="leaf"/></span>CareAlong</a><span className="tagline">Daily support. Connected care.</span><div className="header-end"><span className="demo-tag">Synthetic care demonstration</span>{snapshot && <><span className="identity-chip">{snapshot.actor.name}<small>{role}</small></span><button className="quiet-button" onClick={logout}>Sign out</button></>}</div></header>
    {!token ? <main className="login-layout"><section className="login-intro"><p className="eyebrow">A LITTLE SUPPORT. A REAL CONNECTION.</p><h1>Care starts with<br/>a conversation.</h1><p>A familiar voice. A thoughtful check-in.<br/>And a care team that knows what comes next.</p><div className="login-art" aria-hidden="true"><div className="art-sun"/><div className="art-leaf one"/><div className="art-leaf two"/><div className="art-leaf three"/><div className="art-stem"/><div className="art-vase"/></div><div className="intro-note"><Icon name="heart"/><span>Designed for connection.<br/><strong>Built around your control.</strong></span></div></section><section className="login-card"><span className="label-icon"><Icon name="shield"/></span><p className="eyebrow">WELCOME TO CAREALONG</p><h2>Your own space<br/>to check in.</h2><p>Sign in with your assigned demonstration identity.</p><form onSubmit={login}><label>Who is signing in?<select value={username} onChange={e => setUsername(e.target.value)}>{(config?.identities || []).map((p: RecordData) => <option key={p.username} value={p.username}>{p.name} · {p.role}</option>)}</select></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required/></label><button className="primary" disabled={busy || !config}>{busy ? 'Signing in…' : 'Sign in securely'}<Icon name="arrow"/></button></form><p className="small-text">Each person has a separate identity and assigned access. Ask your demonstration administrator for your sign-in details.</p>{error && <div role="alert" className="notice error">{error}</div>}</section></main> : !snapshot ? <main><p role="status">Connecting to your care workspace…</p>{error && <div role="alert" className="notice error">{error}</div>}<button className="secondary" onClick={logout}>Return to sign in</button></main> : <main>
      <div className="page-title"><div><p className="eyebrow">{role === 'resident' ? 'YOUR DAILY CHECK-IN' : role === 'admin' ? 'AGENT IDENTITY & CONTROL' : 'YOUR CARE WORKSPACE'}</p><h1>{role === 'resident' ? `${greeting}, ${snapshot.actor.name}.` : role === 'admin' ? 'Trust you can verify.' : `A clear next step, ${snapshot.actor.name.split(' ')[0]}.`}</h1><p>{role === 'resident' ? 'A moment for you. Your care team is part of the conversation.' : role === 'admin' ? 'Manage delegated capabilities and inspect what actually happened.' : 'Review, acknowledge, and follow through for the residents assigned to you.'}</p></div><span className="date-label">{new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span></div>
      {error && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice" role="status">{notice}</div>}
      {role === 'resident' && <>
        {snapshot.emergency && <section className="emergency" role="alert"><strong>Immediate help is needed</strong><p>{snapshot.emergency}</p><button className="primary" onClick={() => setHelp(true)}>Show direct-help information</button></section>}
        <div className="senior-grid"><section className="conversation-card"><div className="card-top"><span className="eyebrow">A SPACE TO TALK</span><span className={`session-label ${active ? 'live' : ''}`}><i/>{phase === 'speaking' ? 'CareAlong is speaking' : phase === 'listening' ? 'Listening' : phase === 'typed' ? 'Typed check-in · microphone off' : phase === 'renewing' ? 'Reconnecting voice' : phase === 'stopping' ? 'Stopping · local microphone off' : 'Microphone off'}</span></div><div className={`care-orb ${phase === 'speaking' ? 'speaking' : ''}`} aria-hidden="true"><div className="orb-core"><span/><span/><span/><span/><span/></div><div className="orbit-dot"/></div><h2>{active ? snapshot.question : phase === 'stopped' ? 'Thank you for checking in.' : 'How are you feeling today?'}</h2><p className="voice-description">{active ? 'Take your time. You can interrupt, correct a response, or ask for a person.' : 'Talk about your day, a concern, or something you need a hand with.'}</p>
          {!active && phase !== 'stopping' ? <><label className="consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/><span>I agree to this check-in and local sound analysis. I’ll review any request before it is shared.</span></label><div className="start-buttons"><button className="primary" disabled={!consent || busy} onClick={() => start('voice')}><Icon name="mic"/>Start voice check-in</button><button className="secondary" disabled={!consent || busy} onClick={() => start('typed')}>I’d rather type</button></div></> : <div className="checkin-controls"><button className="stop-button" onClick={stop}>■ {phase === 'stopping' ? 'Check stop status' : 'Stop check-in'}</button>{['listening', 'speaking', 'renewing'].includes(phase) && <button className="secondary" disabled={phase === 'renewing'} onClick={reconnectVoice}>Reconnect voice</button>}<span className="sound-label">{phase === 'typed' ? 'Sound analysis is off' : detector === 'active' ? 'Sound analysis is on · tentative observations' : 'Sound analysis unavailable'}</span></div>}
          <div className="voice-foot"><Icon name="shield"/><span>This app does not save raw microphone audio.</span></div></section>
          <aside className="care-sidebar"><section className="team-card"><p className="eyebrow">CONNECTED TO YOUR CARE TEAM</p><div className="team-avatar">{primaryTask?.owner_name?.[0] || 'S'}</div><h2>{primaryTask?.owner_name || 'Your assigned care team'}</h2><p>{primaryTask ? statusLabel(primaryTask.status) : 'A human handoff, when you want one.'}</p><div className="team-state"><span className="state-dot"/><span>{primaryTask?.acknowledged_by ? `${primaryTask.acknowledged_by} acknowledged your request at ${time(primaryTask.acknowledged_at)}.` : primaryTask ? 'Your request is waiting for an acknowledgment. No response time has been promised.' : 'You’re in control of what is shared.'}</span></div>{primaryTask?.next_step && <div className="next-step"><span>YOUR NEXT STEP</span><p>{primaryTask.next_step.text}</p><small>Recorded by {primaryTask.next_step.actor}. {primaryTask.status === 'RESOLVED' ? 'Staff marked this request resolved.' : 'The concern remains open until staff resolve it.'}</small></div>}</section><button className="human-help" onClick={() => setHelp(true)}><Icon name="heart"/><span>I’d like human help<small>Available even when your session ends</small></span><Icon name="arrow"/></button><div className="demo-note"><strong>A demonstration, not a medical assessment.</strong><p>CareAlong can help clarify and coordinate. It does not diagnose, change medication, or dispatch emergency services.</p></div></aside></div>
        {snapshot.drafts?.map(draft => <section className="sharing-card" key={draft.id}><div><p className="eyebrow">REVIEW BEFORE SHARING</p><h2>Send this request to {draft.recipient}?</h2><p>{draft.summary.request}</p><div className="sharing-summary">{draft.summary.reported.map((r: RecordData) => <p key={r.id}>{r.question && <small>Asked: {r.question}</small>}You said: “{r.quote}”</p>)}{draft.summary.recorded?.map((r: RecordData, i: number) => <p key={i}><strong>From the record:</strong> {r.statement}<small>{r.source_ref}</small></p>)}</div></div><div className="sharing-buttons"><button className="primary" disabled={busy || !active} onClick={() => confirmDraft(draft, true)}><Icon name="check"/>Yes, share this request</button><button className="secondary" disabled={busy || !active} onClick={() => confirmDraft(draft, false)}>No, don’t share</button><button className="quiet-button" onClick={() => action(async () => { const result = await api(`/requests/${draft.request_id}`); setNotice(result.status === 'CREATED' ? 'Your request is already recorded.' : 'No completed request was found yet. Its status remains unknown.'); })}>Check request status</button></div></section>)}
        <section className="conversation-history"><div className="section-title"><div><p className="eyebrow">YOUR WORDS, KEPT IN CONTEXT</p><h2>Our conversation</h2></div>{active && <button className="secondary small-button" disabled={busy} onClick={() => action(async () => { const context = await api(`/runs/${snapshot.run?.id}/context`, {}); if (!context.ok) throw new Error('Your care context is unavailable. You can still contact your care team directly.'); setNotice('Your permitted care context was consulted.'); })}>Ask about my care</button>}</div><div className="transcript" ref={captionPanel} onScroll={e => { const p = e.currentTarget; setFollowCaptions(p.scrollHeight - p.scrollTop - p.clientHeight < 72); }} role="log" aria-live="polite">{turns.length ? turns.map(turn => <div key={turn.id} className={`turn ${turn.role === 'USER' ? 'resident-turn' : ''}`}><span>{turn.role === 'USER' ? 'You' : 'CareAlong'}</span><p>{turn.text}{!turn.final && <small> · transcribing</small>}</p></div>) : <div className="empty-state"><Icon name="message"/><p>Your captions will appear here.<br/>A possible sound is kept separate from your words.</p></div>}</div>{!followCaptions && <button className="quiet-button" onClick={() => setFollowCaptions(true)}>Jump to latest captions</button>}{active && <form className="type-form" onSubmit={e => { e.preventDefault(); void sendText(typed); }}><label className="sr-only" htmlFor="typed-response">Type your response</label><input id="typed-response" value={typed} onChange={e => setTyped(e.target.value)} placeholder="Type your response…" maxLength={2000}/><button className="primary" disabled={busy || !typed.trim()}>Send<Icon name="arrow"/></button></form>}
          {active && snapshot.incident && ['source', 'new', 'breathing', 'head-confirm', 'pickup', 'supply'].includes(snapshot.incident.phase) && <div className="answer-buttons"><button className="secondary" disabled={busy} onClick={() => sendText('Yes.')}>Yes</button><button className="secondary" disabled={busy} onClick={() => sendText('No.')}>No</button><button className="quiet-button" disabled={busy} onClick={() => sendText('I am not sure.')}>I’m not sure</button></div>}
          {active && snapshot.incident?.state === 'CONFIRMED_CONCERN' && !snapshot.drafts?.length && <button className="primary prepare" disabled={busy} onClick={() => action(async () => { await api(`/runs/${snapshot.run?.id}/context`, {}); const result = await api(`/runs/${snapshot.run?.id}/propose`, { incident_id: snapshot.incident?.id, assistance: 'Please help me with this confirmed concern.' }); if (!result.ok) throw new Error(result.code); })}>Prepare a care-team request<Icon name="arrow"/></button>}
        </section>
        {!!snapshot.tasks?.filter(task => task.id !== primaryTask?.id).length && <section className="evidence-section"><h2>Other care requests</h2><p>These are separate requests. They do not describe the status of this check-in.</p>{snapshot.tasks?.filter(task => task.id !== primaryTask?.id).map(task => <details className="past-request" key={task.id}><summary>{task.owner_name} · {statusLabel(task.status)} · {new Date(task.createdAt).toLocaleString()}</summary><p>{task.summary.request}</p>{task.acknowledged_by && <p>Acknowledged by {task.acknowledged_by}.</p>}{task.next_step && <p>{task.next_step.text}</p>}</details>)}</section>}
        {!!snapshot.evidence?.length && <section className="evidence-section"><h2>What we understood</h2><p>Sounds, statements, and records are different kinds of information.</p><div className="evidence-list">{snapshot.evidence.filter(e => e.type !== 'inferred').map(e => <div className="evidence-row" key={e.id}><span className={`evidence-tag ${e.type}`}>{e.type === 'observed' ? 'Possible sound' : 'You reported'}</span><p>{e.statement}{e.superseded && <strong> · corrected</strong>}</p><span>{time(e.createdAt)}</span>{e.type === 'reported' && !e.superseded && active && <button className="quiet-button" onClick={() => { setCorrection(e); setCorrectionText(e.statement); }}>Correct</button>}</div>)}</div></section>}
      </>}
      {['nurse', 'caregiver'].includes(role) && <section className="staff-workspace"><div className="inbox-summary"><span className="label-icon"><Icon name="heart"/></span><div><strong>{snapshot.tasks?.filter(t => t.status !== 'RESOLVED').length || 0}</strong><span>requests need follow-through</span></div><p>Only residents assigned to your identity appear here.</p></div><div className="task-list">{!snapshot.tasks?.length && <div className="empty-state roomy"><Icon name="check"/><h2>Your queue is clear.</h2><p>Confirmed requests assigned to you will appear here live.</p></div>}{snapshot.tasks?.map(task => <article className="task-card" key={task.id} data-task-id={task.id}><div className="task-heading"><div className="person-avatar">{task.resident[0]}</div><div><h2>{task.resident}</h2><p>Created {time(task.createdAt)} · {task.route.replaceAll('-', ' ')}</p></div><span className={`task-status ${task.status.toLowerCase()}`}>{statusLabel(task.status)}</span></div>{task.correction_pending && <div className="notice">The resident corrected a statement. Review the linked evidence before proceeding.</div>}<p className="task-request">{task.summary.request}</p><div className="staff-evidence">{snapshot.evidence?.filter(e => task.evidence_ids.includes(e.id)).map(e => <div key={e.id}><span className={`evidence-tag ${e.type}`}>{e.type}</span><p>{e.in_response_to && <small>Asked: {e.in_response_to}</small>}{e.statement}{e.superseded && ' · corrected'}</p><small>{e.source_ref} · {time(e.createdAt)}</small></div>)}</div><div className="task-rule"><span>Demonstration pathway · {task.protocol_version}</span><span>Clinical concern stays open after acknowledgment</span></div>{task.next_step && <div className="next-step"><strong>Next step recorded by {task.next_step.actor}</strong><p>{task.next_step.text}</p></div>}<div className="task-actions">{task.status === 'CREATED' && <button className="primary" disabled={busy} onClick={() => action(() => api(`/tasks/${task.id}/acknowledge`, { resident_id: task.residentId }))}>Acknowledge request<Icon name="check"/></button>}{['ACKNOWLEDGED', 'NEXT_STEP_RECORDED'].includes(task.status) && <><label>Callback or next step<input value={nextSteps[task.id] || ''} onChange={e => setNextSteps({ ...nextSteps, [task.id]: e.target.value })} placeholder="e.g. I will call Margaret at 3:30 PM" maxLength={500}/></label><button className="primary" disabled={busy || !nextSteps[task.id]?.trim()} onClick={() => action(() => api(`/tasks/${task.id}/next-step`, { resident_id: task.residentId, text: nextSteps[task.id] }))}>Save next step</button><button className="secondary" disabled={busy || !nextSteps[task.id]?.trim() || nextSteps[task.id].length > 470} onClick={() => action(() => api(`/tasks/${task.id}/next-step`, { resident_id: task.residentId, text: `Clarification requested: ${nextSteps[task.id]}` }))}>Request clarification</button>{role === 'nurse' && <button className="secondary" disabled={busy} onClick={() => action(() => api(`/tasks/${task.id}/resolve`, { resident_id: task.residentId }))}>Resolve after review</button>}</>}</div></article>)}</div></section>}
      {role === 'admin' && <div className="admin-layout"><aside className="run-list"><p className="eyebrow">RESIDENT RUNS</p>{snapshot.runs?.map(run => <button className={run.id === selected?.id ? 'selected' : ''} key={run.id} onClick={() => setSelectedRun(run.id)}><span>{run.alias}</span><small>{statusLabel(run.state)} · {time(run.createdAt)}</small></button>)}{!snapshot.runs?.length && <p>No check-ins yet.</p>}</aside><div className="admin-main">{selected && <><section className="admin-card"><div className="section-title"><div><p className="eyebrow">DELEGATED AGENT RUN</p><h2>{selected.alias}’s check-in</h2></div><span className="task-status">{statusLabel(selected.state)}</span></div><dl><div><dt>Workload identity</dt><dd>{selected.agent_subject}</dd></div><div><dt>Run</dt><dd>{selected.id}</dd></div><div><dt>Control boundary</dt><dd>Private MCP gateway · one resident · current grants</dd></div></dl><p className="admin-note">Administrative access does not include clinical detail. Already-returned context cannot be erased by revocation.</p><div className="grant-list">{grants.map(grant => <div key={grant.id}><span><code>{grant.tool}</code><small>Version {grant.version} · {grant.revokedAt ? 'Revoked' : 'Active'}</small></span><button className="secondary" disabled={busy || !!grant.revokedAt} onClick={() => action(() => api(`/runs/${selected.id}/revoke`, { tool: grant.tool }))}>{grant.revokedAt ? 'Revoked' : 'Revoke'}</button></div>)}</div><div className="admin-controls"><button className="primary" disabled={busy} onClick={() => action(async () => { const result = await api(`/runs/${selected.id}/probe`, {}); setNotice(`Actual gateway result: ${result.code}. Clinical result withheld from this view.`); })}>Test next context request</button><button className="stop-button" disabled={busy || selected.state === 'STOPPED'} onClick={() => action(() => api(`/runs/${selected.id}/stop`, {}))}>Stop agent run</button></div></section><section className="admin-card"><h2>Action receipts</h2><div className="receipts-table"><table><thead><tr><th>Time</th><th>Tool</th><th>Decision / result</th><th>Grant</th><th>Effect started</th></tr></thead><tbody>{snapshot.receipts?.filter(r => r.run_id === selected.id).map(r => <tr key={r.id}><td>{time(r.createdAt)}</td><td><code>{r.tool}</code></td><td><strong className={r.decision === 'DENY' ? 'denied-text' : ''}>{r.status}</strong><small>{r.reason}</small></td><td>{r.grant_version ?? '—'}</td><td>{r.effect_started ? 'Yes' : 'No'}</td></tr>)}</tbody></table></div><p className="small-text">An allowed request is not necessarily a successful action. UNKNOWN outcomes must be reconciled.</p></section></>}</div></div>}
      <footer className="care-footer"><span>CareAlong · Daily support. Connected care.</span><span>Synthetic residents · Demonstration rules require clinical review</span></footer>
    </main>}
    {help && <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="help-title"><span className="label-icon"><Icon name="heart"/></span><h2 id="help-title">A person can help.</h2><p>Contact your community’s care desk or a staff member directly.</p><p>If you are experiencing a medical emergency in the United States, call <strong>911</strong> or ask someone nearby to call.</p><div className="notice">This demonstration has not called anyone or dispatched emergency services.</div><button className="primary" autoFocus onClick={() => setHelp(false)}>I understand</button></section></div>}
    {correction && <div className="modal-backdrop"><form className="modal" role="dialog" aria-modal="true" aria-labelledby="correct-title" onSubmit={e => { e.preventDefault(); void action(async () => { await api(`/runs/${snapshot?.run?.id}/correct`, { evidence_id: correction.id, text: correctionText }); setCorrection(null); }); }}><h2 id="correct-title">Let’s correct that.</h2><label>What did you mean?<textarea autoFocus value={correctionText} onChange={e => setCorrectionText(e.target.value)} maxLength={2000}/></label><p>We’ll keep your correction linked to the original statement. Any unconfirmed request will need a new review.</p><button className="primary" disabled={busy || !correctionText.trim()}>Save correction</button><button className="secondary" type="button" onClick={() => setCorrection(null)}>Cancel</button></form></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
