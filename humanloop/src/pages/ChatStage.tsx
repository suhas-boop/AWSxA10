import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bot } from '../components/Bot';
import { Icon } from '../components/Icon';
import { useCare, type Data } from '../lib/care';
import { useVoice, type Transcript } from '../lib/useVoice';

export default function ChatStage({ workflow = 'clinical' }: { workflow?: 'social' | 'clinical' }) {
  const care = useCare();
  const [turns, setTurns] = useState<Transcript[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [review, setReview] = useState(false), [follow, setFollow] = useState(true);
  const followRef = useRef(follow); followRef.current = follow;
  const panel = useRef<HTMLElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const voice = useVoice({ workflow, onTranscript: turn => setTurns(rows => { const found = rows.some(r => r.id === turn.id); return (found ? rows.map(r => r.id === turn.id ? turn : r) : [...rows, turn]).slice(-100); }), onReset: () => { setTurns([]); setFollow(true); } });
  const active = ['live', 'renewing', 'typed'].includes(voice.status), voiceOn = ['live', 'renewing', 'connecting'].includes(voice.status);
  const state = care.snapshot!, incident = state.incident;
  const currentRun = state.run?.id === voice.runId;
  const pending = currentRun ? state.drafts?.[0] : undefined;
  const task = state.tasks?.find((t: Data) => t.run_id === voice.runId);
  const status = voice.status === 'connecting' ? 'Connecting…' : voice.status === 'renewing' ? 'Reconnecting…' : voice.status === 'stopping' ? 'Listening is off · confirming stop' : voice.status === 'typed' ? 'Typed check-in · microphone off' : voice.status === 'live' ? voice.speaking ? 'Your companion is speaking' : 'Listening…' : 'Microphone off';
  const botState = voice.speaking ? 'speaking' : voice.status === 'live' ? 'listening' : 'idle';
  const act = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); try { await action(); await care.refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const send = async (value: string) => { if (!value.trim()) return; await act(async () => { await voice.sendText(value.trim()); }); };
  useLayoutEffect(() => { if (follow && panel.current) panel.current.scrollTop = panel.current.scrollHeight; }, [turns, follow]);
  useEffect(() => { const p = panel.current; if (!p) return; const observer = new ResizeObserver(() => { if (followRef.current) p.scrollTop = p.scrollHeight; }); observer.observe(p); return () => observer.disconnect(); }, []);
  useEffect(() => { if (review) dialog.current?.showModal(); else dialog.current?.close(); }, [review]);
  useEffect(() => { if (!pending) setReview(false); }, [pending?.id]);
  const prepare = () => act(async () => {
    const result = await care.api(`/runs/${voice.runId}/propose`, { incident_id: incident.id, assistance: 'Please review my reported concern and contact me.' });
    if (!result.ok) throw new Error('The request could not be prepared. Please try again or contact your care team directly.');
    await care.refresh(); setReview(true);
  });
  const confirm = (accepted: boolean) => act(async () => {
    const result = await care.api(`/runs/${voice.runId}/confirm`, { draft_id: pending.id, accepted });
    if (!result.declined && !result.ok) throw new Error('The sharing result is not confirmed. Please check with your care team before retrying.');
    setReview(false);
  });
  return <div className="stage-screen connected-stage">
    <header className="stage-top">
      <button className="chat-back" type="button" aria-label={`Sign out ${state.actor.name}`} title="Sign out" onClick={() => void act(async () => { await voice.stop(); await care.logout(); })}><Icon name="arrow-left" size={28} /></button>
      {task
        ? <div className="stage-status alert care-receipt" role="status"><span className="stage-status-label">Status</span><strong><Icon name="bell" size={20} /> {task.simulation ? task.acknowledged_by ? `Demo alert acknowledged by ${task.acknowledged_by}.` : `Demo alert delivered to ${task.owner_name}’s inbox. Assessment pending. No real notification or call was sent.` : task.acknowledged_by ? `${task.acknowledged_by} acknowledged your request.` : `Request sent to ${task.owner_name}. Awaiting acknowledgment.`}</strong>{task.next_step?.text && <small>{task.next_step.text}</small>}</div>
        : <div className={`stage-status voice-status ${voiceOn ? 'on' : ''}`} role="status"><span className="stage-status-label">Status</span><strong>{status}</strong></div>}
    </header>
    <section className="stage-bot" aria-label={status}>
      <button className="companion-toggle" disabled={!!state.companion?.paused} aria-label={voice.status === 'idle' || voice.status === 'error' ? 'Start voice' : 'End check-in'} aria-describedby="voice-gesture-hint" onClick={() => void (voice.status === 'idle' || voice.status === 'error' ? voice.start() : voice.stop())}><Bot state={botState} level={voice.level} /></button>
      <small id="voice-gesture-hint" className="sr-only">{voiceOn ? 'Tap your companion to stop.' : voice.status === 'stopping' ? 'Tap your companion to retry stopping.' : workflow === 'social' ? 'Tap to talk. Only explicit help requests are shared with your care team.' : 'Tap your companion to start a voice check-in with local sound analysis.'}</small>
      {state.companion?.paused && <p className="voice-note" role="status">Your companion is paused. Please contact your care team.</p>}
      {(voice.message || error || care.error) && <p className="voice-note" role="alert">{error || voice.message || care.error}</p>}
    </section>
    <main className={`stage-messages connected-captions ${follow ? '' : 'reviewing'}`} role="log" aria-label="Our conversation" aria-live="polite" ref={panel} onScroll={e => { const p = e.currentTarget; setFollow(p.scrollHeight - p.scrollTop - p.clientHeight < 80); }}>
      {!turns.length && <div className="stage-msg"><p>{voiceOn ? 'I’m here. Tell me how you’re feeling.' : `Hello, ${state.actor.name}. Ready to talk?`}</p></div>}
      {turns.map(m => <div className={`stage-msg ${m.role === 'USER' ? 'alice' : 'nurse'}`} key={m.id} data-turn-id={m.id}><small className={m.role === 'USER' ? undefined : 'sr-only'}>{m.role === 'USER' ? 'You' : 'Companion'}</small><p>“{m.text}”</p>{!m.final && <span className="caption-progress">Speaking…</span>}</div>)}
    </main>
    <footer className="chat-composer stage-controls connected-controls">
        {active && currentRun && state.emergency && <div className="emergency-guidance" role="alert">{state.emergency}</div>}
        {active && currentRun && incident && incident.topic !== 'heart-failure' && <section className="current-question"><p>{state.question}</p>{['source', 'new', 'breathing', 'head-confirm', 'pickup', 'supply'].includes(incident.phase) && <div className="quick-replies"><button disabled={busy} onClick={() => void send('Yes.')}>Yes</button><button disabled={busy} onClick={() => void send('No.')}>No</button></div>}{incident.phase === 'ready' && !pending && <button className="care-action" disabled={busy} onClick={() => void prepare()}>Prepare a care-team request</button>}</section>}
        {active && pending && <button className="care-action" onClick={() => setReview(true)}>Review request for {pending.recipient}</button>}
        {!(active && currentRun && incident && incident.topic !== 'heart-failure') && <div className="quick-replies feelings" aria-hidden="true">{['Feeling good', 'A bit tired', 'Not well'].map(r => <button type="button" key={r} tabIndex={-1}>{r}</button>)}</div>}
        <form className="chat-form" onSubmit={e => e.preventDefault()}>
          <button type="button" className="round-btn light" aria-hidden="true" tabIndex={-1}><Icon name="camera" size={23} /></button>
          <input placeholder="Type how you’re feeling..." readOnly aria-hidden="true" tabIndex={-1} />
          <button type="button" className={`round-btn mic ${voiceOn ? 'on' : ''}`} disabled={!!state.companion?.paused} aria-label={voice.status === 'idle' || voice.status === 'error' ? 'Start voice' : 'End check-in'} onClick={() => void (voice.status === 'idle' || voice.status === 'error' ? voice.start() : voice.stop())}><Icon name={voiceOn ? 'stop' : 'mic'} size={23} /></button>
          <button type="button" className="round-btn" disabled aria-hidden="true" tabIndex={-1}><Icon name="send" size={23} /></button>
        </form>
    </footer>
    <dialog ref={dialog} className="care-dialog" onCancel={() => { setReview(false); }} onClose={() => { setReview(false); }}><button className="dialog-close" aria-label="Close dialog" onClick={() => { setReview(false); }}>×</button>{pending ? <><h2>Share this request with {pending.recipient}?</h2><p>{pending.summary.request}</p>{pending.summary.reported.map((r: Data) => <blockquote key={r.id}>{r.question && <small>Asked: {r.question}</small>}You said: “{r.quote}”</blockquote>)}{pending.summary.recorded?.map((r: Data, i: number) => <p key={i}><small>From the record: {r.statement}</small></p>)}<p>This creates a review request. It does not promise a visit or response time.</p><button className="primary-consent" disabled={busy} onClick={() => void confirm(true)}>Yes, share this request</button><button className="secondary-consent" disabled={busy} onClick={() => void confirm(false)}>No, don’t share</button></> : null}{error && <p role="alert">{error}</p>}</dialog>
  </div>;
}
