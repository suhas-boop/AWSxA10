import { useEffect, useState, type FormEvent } from 'react';
import { CareProvider, useCare } from './lib/care';
import { Logo } from './components/Logo';
import { Bot } from './components/Bot';
import ChatStage from './pages/ChatStage';
import StaffPortal from './pages/StaffPortal';

function SeniorView() {
  const care = useCare();
  const [route, setRoute] = useState(location.hash);
  useEffect(() => { const changed = () => setRoute(location.hash); window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed); }, []);
  const staff = route.startsWith('#/staff');
  useEffect(() => { setUsername(staff ? 'sam' : 'margaret'); setPassword(''); }, [staff]);
  const [username, setUsername] = useState('margaret'), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const signIn = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(''); try { await care.login(username, password); setPassword(''); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  if (care.token && care.snapshot?.actor.role === 'resident') return <ChatStage key={care.token + route} workflow={route.startsWith('#/companion') ? 'social' : 'clinical'} />;
  if (care.token && care.snapshot && ['admin', 'nurse', 'caregiver'].includes(care.snapshot.actor.role)) return <StaffPortal key={care.token}/>;
  if (care.token) return <main className="humanloop-login"><a className="brand" href="#/">HumanLoop<Logo /></a><h1>{care.snapshot ? 'This account has no portal role' : 'Opening your conversation…'}</h1><p>{care.snapshot ? 'Please sign in with a resident or assigned staff account.' : care.error}</p><button className="secondary-consent" onClick={() => void care.logout()}>Sign out</button></main>;
  return <main className="humanloop-login"><a className="brand" href="#/">HumanLoop<Logo /></a><Bot /><p className="section-kicker">YOUR VOICE. YOUR CHOICE.</p><h1>{staff ? <>A circle of care.<br/>Everyone in the loop.</> : <>A little company.<br/>A listening ear.</>}</h1><p>{staff ? 'Sign in to your staff portal.' : 'Sign in to your voice companion.'}</p><form onSubmit={signIn}><label>Who is signing in?<select value={username} onChange={e => setUsername(e.target.value)}>{care.config?.identities?.filter((p: any) => staff ? p.role !== 'resident' : p.role === 'resident').map((p: any) => <option key={p.username} value={p.username}>{p.name}</option>)}</select></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label><button className="primary-consent" disabled={busy || !care.config}>{busy ? 'Signing in…' : 'Sign in securely'}</button></form>{(error || care.error) && <p className="voice-note" role="alert">{error || care.error}</p>}<small>Synthetic care demonstration</small><a className="staff-login-link" href={staff ? "#/" : "#/staff"}>{staff ? "Resident sign-in" : "Staff sign-in"}</a></main>;
}
export default function App() { return <CareProvider><SeniorView /></CareProvider>; }
