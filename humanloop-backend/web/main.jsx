import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AudioSession } from './audio.mjs';
import './style.css';

const runtimeUrl = import.meta.env.VITE_AGENTCORE_WS_URL;
const labels = { idle: 'Ready when you are', connecting: 'Connecting your conversation', listening: 'Listening to you', speaking: 'Nova is speaking', renewing: 'Refreshing the connection', ending: 'Ending your session', ended: 'Conversation ended' };
const clock = seconds => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

function Mic({ off = false }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0014 0v-2M12 19v3M8 22h8"/>{off && <path d="M3 3l18 18"/>}</svg>;
}

function App() {
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [transcript, setTranscript] = useState([]);
  const [actions, setActions] = useState([]);
  const [muted, setMuted] = useState(false);
  const [toolsEnabled, setToolsEnabled] = useState(true);
  const [token, setToken] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [startedAt, setStartedAt] = useState(null);
  const [sessionId, setSessionId] = useState('');
  const connection = useRef(null);
  const transcriptEnd = useRef(null);
  const connected = ['connecting', 'listening', 'speaking', 'renewing', 'ending'].includes(status);

  useEffect(() => {
    if (runtimeUrl) { setConfig({ authMode: 'jwt', region: 'AgentCore', storage: 'DynamoDB' }); return; }
    fetch('/api/config').then(response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(setConfig).catch(() => setError('The voice backend is unavailable. Start it with npm run dev.'));
    return () => { const current = connection.current; if (current) { current.closed = true; current.socket?.close(); void current.audio?.stop(); } };
  }, []);
  useEffect(() => { if (!connected || !startedAt) return; const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000); return () => clearInterval(timer); }, [connected, startedAt]);
  useEffect(() => { transcriptEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [transcript]);

  function release(current) {
    if (current.closed) return;
    current.closed = true;
    clearTimeout(current.openTimer); clearTimeout(current.closeTimer);
    void current.audio?.stop();
    if (current.socket && current.socket.readyState < WebSocket.CLOSING) current.socket.close();
    if (connection.current === current) { setStatus('ended'); setMuted(false); }
  }

  async function start() {
    const previous = connection.current;
    if (previous && !previous.closed) return;
    setError(''); setNotice(''); setTranscript([]); setActions([]); setElapsed(0); setStartedAt(null); setSessionId('');
    setStatus('connecting'); setMuted(false); setToolsEnabled(true);
    const current = { closed: false, acceptingAudio: false };
    connection.current = current;
    try {
      current.audio = new AudioSession(frame => {
        if (current.closed || !current.acceptingAudio || current.socket?.readyState !== WebSocket.OPEN) return;
        if (current.socket.bufferedAmount > 128000) { setError('The connection is too slow for live audio. Please reconnect.'); release(current); return; }
        current.socket.send(frame);
      }, playing => {
        if (!current.closed) setStatus(value => ['listening', 'speaking'].includes(value) ? (playing ? 'speaking' : 'listening') : value);
      });
      await current.audio.start();
      if (current.closed) return;
      const url = runtimeUrl ? new URL(runtimeUrl) : new URL('/ws', location.href);
      if (!runtimeUrl) url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      else url.searchParams.set('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id', crypto.randomUUID());
      const protocols = config.authMode === 'jwt' ? [`base64UrlBearerAuthorization.${btoa(token.trim()).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`, 'base64UrlBearerAuthorization'] : undefined;
      const ws = new WebSocket(url, protocols);
      current.socket = ws;
      current.openTimer = setTimeout(() => { setError('Connection timed out. Check the backend and your sign-in.'); release(current); }, 20000);
      ws.onopen = () => { if (current.closed) { ws.close(); return; } ws.send(JSON.stringify({ type: 'start' })); };
      ws.onmessage = event => {
        if (current.closed) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'status') {
            setStatus(message.status);
            if (message.status === 'listening') {
              clearTimeout(current.openTimer); current.acceptingAudio = true;
              setStartedAt(value => value || Date.now());
              if (message.sessionId) setSessionId(message.sessionId);
            }
            if (message.status === 'renewing') { current.acceptingAudio = false; current.audio.clear(); }
            if (message.status === 'ended') release(current);
          } else if (message.type === 'audio') current.audio.play(message.data);
          else if (message.type === 'interrupt') current.audio.clear();
          else if (message.type === 'transcript') setTranscript(rows => {
            const index = rows.findIndex(row => row.id === message.id);
            return index < 0 ? [...rows, message].slice(-200) : rows.map((row, i) => i === index ? message : row);
          });
          else if (message.type === 'action') setActions(rows => [...rows, message].slice(-150));
          else if (message.type === 'permissions') setToolsEnabled(message.enabled);
          else if (message.type === 'warning') setNotice(message.message);
          else if (message.type === 'error') { setError(message.message); release(current); }
        } catch { setError('The audio connection could not be processed. Please reconnect.'); release(current); }
      };
      ws.onerror = () => { if (!current.closed) { setError('Could not connect. Check the backend, network, and sign-in settings.'); release(current); } };
      ws.onclose = event => { if (!current.closed) { if (event.code !== 1000) setError('The connection was lost. Start a new session to continue.'); release(current); } };
    } catch (error) {
      if (!current.closed) { setError(error.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow microphone access and try again.' : 'Could not start audio. Use a supported browser on localhost or HTTPS.'); release(current); }
    }
  }

  function stop() {
    const current = connection.current;
    if (!current) return;
    current.acceptingAudio = false; void current.audio?.stop();
    if (current.socket?.readyState === WebSocket.OPEN) {
      setStatus('ending'); current.socket.send(JSON.stringify({ type: 'stop' }));
      current.closeTimer = setTimeout(() => release(current), 6000);
    } else release(current);
  }
  function toggleMute() {
    const next = !muted; connection.current?.audio?.mute(next); setMuted(next);
  }
  function toggleTools() {
    const ws = connection.current?.socket;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'tools', enabled: !toolsEnabled }));
  }
  function download() {
    const blob = new Blob([JSON.stringify({ sessionId, transcript: transcript.filter(row => row.final), actions }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `conversation-${sessionId || 'export'}.json`; link.click(); URL.revokeObjectURL(url);
  }

  return <div className="app-shell">
    <header className="topbar"><a className="wordmark" href="/" aria-label="Nova home"><span className="brand-symbol">n</span>nova<span className="brand-divider"/> <span className="workspace-label">Voice workspace</span></a><div className="top-meta"><span className="small-dot"/>Amazon Nova 2 Sonic<span className="region">{config?.region || 'us-east-1'}</span></div></header>
    <main>
      <div className="page-heading"><div><p className="eyebrow">YOUR CONVERSATION SPACE</p><h1>A little more human.</h1><p className="lede">Talk naturally. Interrupt anytime. Stay in control.</p></div><span className="mode-pill">{config?.authMode === 'jwt' ? 'Authenticated workspace' : 'Local workspace'}</span></div>
      {error && <div role="alert" className="banner error"><strong>Connection needs attention</strong><span>{error}</span></div>}
      {notice && <div role="status" className="banner">{notice}</div>}
      <div className="workspace-grid">
        <section className="voice-panel" aria-label="Voice session">
          <div className="panel-top"><span className="eyebrow">LIVE CONVERSATION</span><span className="session-clock"><span className={connected ? 'small-dot active' : 'small-dot'}/>{clock(elapsed)}</span></div>
          <div className={`orb-scene ${connected ? 'is-live' : ''} ${status === 'speaking' ? 'is-speaking' : ''}`} aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orb"><div className="orb-shine"/><div className="wave">{Array.from({ length: 9 }, (_, i) => <span key={i} style={{ '--i': i, '--h': `${18 + (4 - Math.abs(4 - i)) * 10}px` }}/>)}</div></div><span className="orbit-spark"/></div>
          <div className="voice-copy"><span className="live-tag">{connected ? 'SESSION ACTIVE' : 'SPACE TO THINK OUT LOUD'}</span><h2 aria-live="polite">{muted && connected ? 'Your microphone is muted' : labels[status]}</h2><p>{status === 'renewing' ? 'A brief pause while Nova carries your recent conversation forward.' : connected ? 'Your microphone stays open. You can speak over Nova to interrupt.' : 'Start a session and say hello. Nova will listen and respond in real time.'}</p></div>
          {config?.authMode === 'jwt' && !connected && <label className="token-field">Application access token<input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder="Paste your application sign-in token"/><small>Held in this tab only. This is not an AWS access key.</small></label>}
          <div className="voice-controls">{connected ? <><button className={`icon-button ${muted ? 'selected' : ''}`} onClick={toggleMute} disabled={status === 'ending'} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={muted}><Mic off={muted}/></button><button className="primary-button stop" onClick={stop} disabled={status === 'ending'}><span className="stop-square"/>{status === 'ending' ? 'Ending…' : 'End conversation'}</button></> : <button className="primary-button" onClick={start} disabled={!config || (config.authMode === 'jwt' && !token.trim())}><Mic/>Start conversation<span className="button-arrow">↗</span></button>}</div>
          <div className="privacy-note"><span>◌</span> Microphone is off until you start. This app does not save audio.</div>
          <div className="voice-footer"><span>Natural voice</span><span>Live interruptions</span><span>Tools you control</span></div>
        </section>
        <section className="transcript-panel" aria-label="Conversation transcript"><div className="section-heading"><div><span className="eyebrow">IN THE MOMENT</span><h2>Conversation</h2></div><button className="text-button" onClick={download} disabled={!transcript.length}>Export ↗</button></div>
          <div className="transcript-scroll" role="log" aria-label="Live transcript" aria-live="polite" aria-relevant="additions text">{!transcript.length ? <div className="empty-transcript"><div className="quote-mark">“</div><h3>Every conversation<br/>starts somewhere.</h3><p>Your words and Nova’s responses<br/>will appear here as you talk.</p><div className="suggestion"><span>TRY SAYING</span><p>“Hi Nova, what can you help me with?”</p></div></div> : transcript.map(row => <div className={`transcript-row ${row.role === 'USER' ? 'user' : 'assistant'}`} key={row.id}><div className="speaker-avatar">{row.role === 'USER' ? 'Y' : 'n'}</div><div><span className="speaker-label">{row.role === 'USER' ? 'You' : 'Nova'}{!row.final && <span className="transcribing"> · transcribing</span>}</span><p>{row.text}</p></div></div>)}<div ref={transcriptEnd}/></div>
          <div className="transcript-foot"><span className="small-dot"/>{transcript.length ? 'Showing spoken conversation' : 'Your transcript will stay in this tab'}</div>
        </section>
      </div>
      <section className="actions-panel" aria-label="Agent actions"><div className="actions-intro"><span className="eyebrow">VISIBLE. CONTROLLABLE.</span><h2>Actions, in the open.</h2><p>Tool requests and their outcomes appear here.<br/>Application integrations are awaiting your use case.</p><button className="permission-button" disabled={!connected || status === 'ending'} onClick={toggleTools} aria-pressed={toolsEnabled}><span className={`toggle-track ${toolsEnabled ? 'on' : ''}`}><span/></span>{toolsEnabled ? 'Tools enabled' : 'Tools paused'}</button></div><div className="action-feed">{actions.length ? actions.slice(-8).map((action, i) => <div className="action-row" key={`${action.id}-${i}`}><span className={`action-indicator ${action.status}`}/><span className="action-name">{action.name.replaceAll('_', ' ')}</span><span className={`action-status ${action.status}`}>{action.status}</span><time>{new Date(action.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div>) : <div className="empty-actions"><div className="action-glyph">⌘</div><div><h3>No actions yet</h3><p>Nova can read session information. No external workflows are connected.</p></div><span className="outline-pill">Waiting for a request</span></div>}</div></section>
      <footer className="page-footer"><span>Powered by Amazon Bedrock</span><span>{sessionId ? `Session ${sessionId.slice(0, 8)}` : 'Your voice. Your pace.'}</span></footer>
    </main>
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
