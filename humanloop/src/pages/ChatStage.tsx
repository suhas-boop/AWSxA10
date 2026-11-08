import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Bot } from '../components/Bot';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';
import { useCare, type Data } from '../lib/care';
import { useVoice, type Transcript } from '../lib/useVoice';

export default function ChatStage() {
  const care = useCare();
  const [turns, setTurns] = useState<Transcript[]>([]), [draft, setDraft] = useState(''), [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [help, setHelp] = useState(false), [review, setReview] = useState(false), [follow, setFollow] = useState(true);
  const followRef = useRef(follow); followRef.current = follow;
  const panel = useRef<HTMLElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const voice = useVoice({ onTranscript: turn => setTurns(rows => { const found = rows.some(r => r.id === turn.id); return (found ? rows.map(r => r.id === turn.id ? turn : r) : [...rows, turn]).slice(-100); }), onReset: () => { setTurns([]); setFollow(true); } });
  const active = ['live', 'renewing', 'typed'].includes(voice.status), voiceOn = ['live', 'renewing', 'connecting'].includes(voice.status);
  const state = care.snapshot!, incident = state.incident;
  const currentRun = state.run?.id === voice.runId;
  const pending = currentRun ? state.drafts?.[0] : undefined;
  const task = state.tasks?.find((t: Data) => t.run_id === voice.runId);
  const status = voice.status === 'connecting' ? 'Connecting…' : voice.status === 'renewing' ? 'Reconnecting…' : voice.status === 'stopping' ? 'Listening is off · confirming stop' : voice.status === 'typed' ? 'Typed check-in · microphone off' : voice.status === 'live' ? voice.speaking ? 'Your companion is speaking' : 'Listening…' : 'Microphone off';
  const botState = voice.speaking ? 'speaking' : voice.status === 'live' ? 'listening' : 'idle';
  const act = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); try { await action(); await care.refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const send = async (value: string) => { if (!value.trim()) return; await act(async () => { await voice.sendText(value.trim()); setDraft(''); }); };
  useLayoutEffect(() => { if (follow && panel.current) panel.current.scrollTop = panel.current.scrollHeight; }, [turns, follow]);
  useEffect(() => { const p = panel.current; if (!p) return; const observer = new ResizeObserver(() => { if (followRef.current) p.scrollTop = p.scrollHeight; }); observer.observe(p); return () => observer.disconnect(); }, []);
  useEffect(() => { if (review || help) dialog.current?.showModal(); else dialog.current?.close(); }, [review, help]);
  useEffect(() => { if (!pending) setReview(false); }, [pending?.id]);
  const submit = (e: FormEvent) => { e.preventDefault(); void send(draft); };
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
    <header className="stage-top"><a className="brand" href="#/" aria-label="HumanLoop voice companion">HumanLoop<Logo /></a><div className="senior-identity"><span>{state.actor.name}</span><button onClick={() => void act(async () => { await voice.stop(); await care.logout(); })}>Sign out</button></div></header>
    {task && <div className="care-receipt" role="status">{task.acknowledged_by ? `${task.acknowledged_by} acknowledged your request.` : `Request sent to ${task.owner_name}. Awaiting acknowledgment.`}{task.next_step?.text && <span>{task.next_step.text}</span>}</div>}
    <section className="stage-bot" aria-label={status}><Bot state={botState} level={voice.level} /><p className="live-voice-status" role="status">{status}</p><small>AI voice companion · synthetic demonstration</small></section>
    <main className="stage-messages connected-captions" role="log" aria-label="Our conversation" aria-live="polite" ref={panel} onScroll={e => { const p = e.currentTarget; setFollow(p.scrollHeight - p.scrollTop - p.clientHeight < 80); }}>
      {!turns.length && <div className="stage-msg"><p>{voiceOn ? 'I’m here. Tell me how you’re feeling.' : `Hello, ${state.actor.name}. Ready to talk?`}</p><small>{voiceOn ? 'You can interrupt whenever you like.' : 'Your conversation begins when you press Start voice.'}</small></div>}
      {turns.map(m => <div className={`stage-msg ${m.role === 'USER' ? 'alice' : 'nurse'}`} key={m.id} data-turn-id={m.id}><small>{m.role === 'USER' ? 'You' : 'Companion'}</small><p>{m.text}</p>{!m.final && <span className="caption-progress">Speaking…</span>}</div>)}
    </main>
    {!follow && <button className="latest-captions" onClick={() => setFollow(true)}>Jump to latest captions</button>}
    <footer className="chat-composer stage-controls">
      {(voice.message || error || care.error) && <p className="voice-note" role="alert">{error || voice.message || care.error}</p>}
      {active && currentRun && state.emergency && <div className="emergency-guidance" role="alert">{state.emergency}</div>}
      {active && currentRun && incident && <section className="current-question"><p>{state.question}</p>{['source', 'new', 'breathing', 'head-confirm', 'pickup', 'supply'].includes(incident.phase) && <div className="quick-replies"><button disabled={busy} onClick={() => void send('Yes.')}>Yes</button><button disabled={busy} onClick={() => void send('No.')}>No</button></div>}{incident.phase === 'ready' && !pending && <button className="care-action" disabled={busy} onClick={() => void prepare()}>Prepare a care-team request</button>}</section>}
      {active && pending && <button className="care-action" onClick={() => setReview(true)}>Review request for {pending.recipient}</button>}
      {!active && voice.status !== 'connecting' && voice.status !== 'stopping' && <label className="voice-consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I agree to this check-in and local sound analysis. I’ll review any request before sharing it.</label>}
      <div className="voice-actions">{voice.status === 'idle' || voice.status === 'error' ? <><button className="start-voice" disabled={!consent || busy} onClick={() => void voice.start()}><Icon name="mic" size={22} />Start voice</button><button className="quiet-control" disabled={!consent || busy} onClick={() => void voice.start('typed')}>I’d rather type</button></> : <><button className="end-voice" onClick={() => void voice.stop()}><Icon name="stop" size={18} />{voice.status === 'stopping' ? 'Retry End check-in' : 'End check-in'}</button>{['live', 'renewing'].includes(voice.status) && <button className="quiet-control" disabled={voice.status === 'renewing'} onClick={() => void voice.reconnect()}>Reconnect voice</button>}</>}
      <button className="quiet-control" onClick={() => setHelp(true)}>Human help</button></div>
      {active && <form onSubmit={submit} className="chat-form"><label className="sr-only" htmlFor="stage-message">Type your response</label><input id="stage-message" value={draft} onChange={e => setDraft(e.target.value)} placeholder="Type a response if you prefer…" maxLength={2000} autoComplete="off" /><button className="round-btn" type="submit" aria-label="Send message" disabled={busy || !draft.trim()}><Icon name="send" size={23} /></button></form>}
      {active && <small className="capture-note">{voice.status === 'typed' ? 'Typed answers update your check-in; voice is off.' : voice.detector === 'active' ? 'Local sound analysis is on. Possible sounds need your confirmation.' : 'Sound analysis is unavailable. Please describe any concern.'}</small>}
    </footer>
    <dialog ref={dialog} className="care-dialog" onCancel={() => { setHelp(false); setReview(false); }} onClose={() => { setHelp(false); setReview(false); }}><button className="dialog-close" aria-label="Close dialog" onClick={() => { setHelp(false); setReview(false); }}>×</button>{help ? <><h2>Contact a person</h2><p>Contact your community care desk or assigned care team directly. HumanLoop has not placed a call.</p><p>For an emergency, use your local emergency service.</p></> : pending ? <><h2>Share this request with {pending.recipient}?</h2><p>{pending.summary.request}</p>{pending.summary.reported.map((r: Data) => <blockquote key={r.id}>{r.question && <small>Asked: {r.question}</small>}You said: “{r.quote}”</blockquote>)}{pending.summary.recorded?.map((r: Data, i: number) => <p key={i}><small>From the record: {r.statement}</small></p>)}<p>This creates a review request. It does not promise a visit or response time.</p><button className="primary-consent" disabled={busy} onClick={() => void confirm(true)}>Yes, share this request</button><button className="secondary-consent" disabled={busy} onClick={() => void confirm(false)}>No, don’t share</button></> : null}{error && <p role="alert">{error}</p>}</dialog>
  </div>;
}
