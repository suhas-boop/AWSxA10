import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioSession } from '../../../humanloop-backend/web/audio.mjs';
import { SoundDetector } from '../../../humanloop-backend/web/detector.mjs';
import { useCare, type Data } from './care';

export type VoiceStatus = 'idle' | 'connecting' | 'live' | 'renewing' | 'typed' | 'stopping' | 'error';
export type Transcript = { id: string; role: 'USER' | 'ASSISTANT'; text: string; final: boolean };
type Resources = { cancelled: boolean; accepting: boolean; runId?: string; audio?: any; detector?: any; socket?: WebSocket; heartbeat?: ReturnType<typeof setInterval>; opening?: ReturnType<typeof setTimeout>; stopPromise?: Promise<void> };
export function useVoice(handlers: { workflow?: 'social' | 'clinical'; onTranscript: (turn: Transcript) => void; onReset: () => void }) {
  const { api, token, refresh } = useCare();
  const [status, setStatus] = useState<VoiceStatus>('idle'), [message, setMessage] = useState('');
  const [level, setLevel] = useState(0), [speaking, setSpeaking] = useState(false), [detector, setDetector] = useState('stopped');
  const resources = useRef<Resources | null>(null), handlersRef = useRef(handlers); handlersRef.current = handlers;
  const apiRef = useRef(api); apiRef.current = api;
  const stopResource = useCallback((r: Resources, update = true): Promise<void> => {
    if (r.stopPromise) return r.stopPromise;
    r.cancelled = true; r.accepting = false; clearInterval(r.heartbeat); clearTimeout(r.opening);
    r.detector?.stop(); const stoppingAudio = r.audio?.stop();
    if (r.socket) { r.socket.onclose = null; r.socket.onerror = null; r.socket.onmessage = null; r.socket.close(); }
    if (update) { setStatus('stopping'); setLevel(0); setSpeaking(false); setDetector('stopped'); }
    r.stopPromise = (async () => {
      try {
        await stoppingAudio;
        if (r.runId) await apiRef.current(`/runs/${r.runId}/stop`, {});
        if (resources.current === r) { resources.current = null; if (update) setStatus('idle'); }
      } catch {
        r.stopPromise = undefined;
        if (update) { setStatus('stopping'); setMessage('Listening is off. Tap your companion again to confirm the check-in stopped.'); }
      }
    })(); return r.stopPromise;
  }, []);
  const stop = useCallback(async () => { const r = resources.current; if (r) await stopResource(r); setMessage(''); await refresh().catch(() => {}); }, [stopResource, refresh]);
  const fail = useCallback((r: Resources, text: string) => { if (resources.current !== r || r.cancelled) return; setMessage(text); void stopResource(r); }, [stopResource]);
  const start = useCallback(async (mode: 'voice' | 'typed' = 'voice') => {
    if (resources.current) return;
    const r: Resources = { cancelled: false, accepting: false }; resources.current = r;
    setStatus('connecting'); setMessage(''); handlersRef.current.onReset();
    try {
      // Begin microphone permission from the button gesture, before network calls.
      if (mode === 'voice') {
        let lastMeter = 0;
        r.audio = new AudioSession((frame: ArrayBuffer) => {
          if (r.cancelled) return;
          if (Date.now() - lastMeter > 80) { const pcm = new Int16Array(frame); let sum = 0; for (const sample of pcm) sum += (sample / 32768) ** 2; setLevel(Math.sqrt(sum / pcm.length)); lastMeter = Date.now(); }
          r.detector?.frame(frame, performance.now() - started);
          if (r.accepting && r.socket?.readyState === WebSocket.OPEN) {
            if (r.socket.bufferedAmount > 128000) return fail(r, 'Audio is delayed. Please start a new check-in.');
            r.socket.send(frame);
          }
        }, (playing: boolean) => { if (resources.current === r && !r.cancelled) setSpeaking(playing); });
        await r.audio.start();
        if (r.cancelled) { await r.audio.stop(); return; }
      }
      const run = await api('/runs', { consent: true, workflow: handlersRef.current.workflow || 'clinical' }); r.runId = run.id;
      if (r.cancelled) { await api(`/runs/${run.id}/stop`, {}); return; }
      r.heartbeat = setInterval(() => { void api(`/runs/${run.id}/heartbeat`, {}).catch(() => fail(r, 'The connection was lost. Listening has stopped. Please start again.')); }, 2000);
      if (mode === 'typed') { await api(`/runs/${run.id}/analysis`, { analysis: 'typed-only', detector: 'unavailable' }); if (!r.cancelled) setStatus('typed'); await refresh(); return; }
      const started = performance.now();
      if (handlersRef.current.workflow !== 'social') {
      r.detector = new SoundDetector((observation: Data) => { if (!r.cancelled) void api(`/runs/${run.id}/observations`, observation).catch(() => setMessage('A sound observation could not be saved. Please describe your concern.')); }, (value: string) => {
        if (!r.cancelled) { setDetector(value); void api(`/runs/${run.id}/analysis`, { analysis: 'voice', detector: value }).catch(() => {}); }
      });
      void r.detector.start().catch(() => { if (!r.cancelled) setDetector('unavailable'); });
      }
      const url = new URL('/ws', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('run', run.id);
      const encoded = btoa(token).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const socket = new WebSocket(url, [`carealong-token.${encoded}`, 'carealong']); r.socket = socket;
      r.opening = setTimeout(() => fail(r, 'Voice could not connect. Please try again.'), 20000);
      socket.onmessage = ({ data }) => {
        if (r.cancelled) return;
        try {
          const m = JSON.parse(data);
          if (m.type === 'status') {
            if (m.status === 'listening') { clearTimeout(r.opening); r.accepting = true; setStatus('live'); setMessage(''); }
            if (m.status === 'renewing') { r.accepting = false; r.audio.clear(); setStatus('renewing'); }
            if (m.status === 'ended') void stopResource(r);
          }
          if (m.type === 'audio') r.audio.play(m.data);
          if (m.type === 'interrupt') r.audio.clear();
          if (m.type === 'transcript') handlersRef.current.onTranscript(m);
          if (m.type === 'error') fail(r, m.message);
        } catch { fail(r, 'Voice playback could not continue. Please start a new check-in.'); }
      };
      socket.onerror = () => fail(r, 'Voice disconnected. Please start a new check-in.');
      socket.onclose = () => { if (!r.cancelled) fail(r, 'Voice ended. You can start a new check-in.'); };
      await refresh();
    } catch (e) { fail(r, (e as Error).name === 'NotAllowedError' ? 'Microphone access was blocked. Allow microphone access in your browser, then tap your companion to try again.' : (e as Error).message); }
  }, [api, token, refresh, fail, stopResource]);
  const sendText = useCallback(async (text: string) => {
    const r = resources.current; if (!r?.runId || r.cancelled) throw new Error('Start a check-in first.');
    const id = crypto.randomUUID(); await api(`/runs/${r.runId}/turns`, { text, turn_id: id });
    handlersRef.current.onTranscript({ id, role: 'USER', text, final: true }); await refresh();
  }, [api, refresh]);
  const reconnect = useCallback(async () => {
    const r = resources.current; if (!r || r.cancelled || r.socket?.readyState !== WebSocket.OPEN) return;
    try { await r.audio.resume(); r.audio.clear(); r.socket.send(JSON.stringify({ type: 'reconnect' })); setMessage('Reconnecting. Repeat your last sentence when Listening returns.'); }
    catch { fail(r, 'Voice could not reconnect. Please start a new check-in.'); }
  }, [fail]);
  useEffect(() => () => { const r = resources.current; if (r) void stopResource(r, false); }, [stopResource]);
  return { status, message, level, speaking, detector, start, stop, sendText, reconnect, runId: resources.current?.runId };
}
