import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export type Data = Record<string, any>;
export type CareApi = (path: string, body?: Data) => Promise<Data>;
type Care = { token: string; snapshot: Data | null; config: Data | null; error: string; api: CareApi; refresh: () => Promise<void>; login: (username: string, password: string) => Promise<void>; logout: () => Promise<void> };
const Context = createContext<Care | null>(null);
export function CareProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(() => sessionStorage.getItem('carealong-session') || '');
  const [snapshot, setSnapshot] = useState<Data | null>(null), [config, setConfig] = useState<Data | null>(null), [error, setError] = useState('');
  const currentToken = useRef(token); currentToken.current = token;
  const request = useCallback(async (path: string, body: Data | undefined, auth: string, signal?: AbortSignal) => {
    const r = await fetch('/api' + path, { method: body === undefined ? 'GET' : 'POST', signal: signal || AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await r.json();
    if (!r.ok) throw new Error(value.message || 'The request could not be completed. Please try again.');
    return value;
  }, []);
  const api: CareApi = useCallback((path, body) => request(path, body, token), [request, token]);
  const refresh = useCallback(async () => { const value = await api('/state'); if (currentToken.current === token) setSnapshot(value); }, [api, token]);
  useEffect(() => { const controller = new AbortController(); request('/config', undefined, '', controller.signal).then(setConfig).catch(e => { if (!controller.signal.aborted) setError(e.message); }); return () => controller.abort(); }, [request]);
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController(); let retry: ReturnType<typeof setTimeout>;
    const subscribe = async () => {
      try {
        const response = await fetch('/api/events', { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
        if (response.status === 401 || response.status === 403) throw new Error('AUTH_INVALID');
        if (!response.ok || !response.body) throw new Error('Your connection is unavailable. Reconnecting…');
        const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read(); if (done) break;
          pending += decoder.decode(value, { stream: true }); let end;
          while ((end = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, end); pending = pending.slice(end + 2);
            if (frame.includes('event: auth-error')) throw new Error('AUTH_INVALID');
            const data = frame.split('\n').find(line => line.startsWith('data: '));
            if (data && currentToken.current === token) { setSnapshot(JSON.parse(data.slice(6))); setError(''); }
          }
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        if ((e as Error).message === 'AUTH_INVALID') { sessionStorage.removeItem('carealong-session'); setToken(''); setSnapshot(null); setError('Please sign in again.'); return; }
        setError('Your connection is unavailable. Reconnecting…');
      }
      if (!controller.signal.aborted) retry = setTimeout(subscribe, 1500);
    };
    void subscribe(); return () => { controller.abort(); clearTimeout(retry); };
  }, [token]);
  const login = async (username: string, password: string) => { const value = await request('/login', { username, password }, ''); setSnapshot(null); sessionStorage.setItem('carealong-session', value.token); setToken(value.token); setError(''); };
  const logout = async () => { try { await api('/logout', {}); } finally { sessionStorage.removeItem('carealong-session'); setToken(''); setSnapshot(null); } };
  return <Context.Provider value={{ token, snapshot, config, error, api, refresh, login, logout }}>{children}</Context.Provider>;
}
export function useCare() { const value = useContext(Context); if (!value) throw new Error('Missing CareProvider'); return value; }
