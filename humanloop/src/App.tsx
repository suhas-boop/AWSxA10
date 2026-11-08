import { useState, type FormEvent } from 'react';
import { CareProvider, useCare } from './lib/care';
import { Logo } from './components/Logo';
import { Bot } from './components/Bot';
import ChatStage from './pages/ChatStage';

function SeniorView() {
  const care = useCare();
  const [username, setUsername] = useState('margaret'), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const signIn = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(''); try { await care.login(username, password); setPassword(''); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  if (care.token && care.snapshot?.actor.role === 'resident') return <ChatStage key={care.token} />;
  if (care.token) return <main className="humanloop-login"><a className="brand" href="#/">HumanLoop<Logo /></a><h1>{care.snapshot ? 'This view is for senior residents' : 'Opening your conversation…'}</h1><p>{care.snapshot ? 'Please sign in with a resident account. The care-team view will be connected separately.' : care.error}</p><button className="secondary-consent" onClick={() => void care.logout()}>Sign out</button></main>;
  return <main className="humanloop-login"><a className="brand" href="#/">HumanLoop<Logo /></a><Bot /><p className="section-kicker">YOUR VOICE. YOUR CHOICE.</p><h1>A little company.<br/>A listening ear.</h1><p>Sign in to your voice companion.</p><form onSubmit={signIn}><label>Who is signing in?<select value={username} onChange={e => setUsername(e.target.value)}>{care.config?.identities?.filter((p: any) => p.role === 'resident').map((p: any) => <option key={p.username} value={p.username}>{p.name}</option>)}</select></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label><button className="primary-consent" disabled={busy || !care.config}>{busy ? 'Signing in…' : 'Sign in securely'}</button></form>{(error || care.error) && <p className="voice-note" role="alert">{error || care.error}</p>}<small>Synthetic care demonstration</small></main>;
}
export default function App() { return <CareProvider><SeniorView /></CareProvider>; }
