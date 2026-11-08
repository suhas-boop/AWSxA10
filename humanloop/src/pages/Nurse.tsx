import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Logo";
import type { NurseAlert } from "../types";

export default function Nurse() {
  const [alerts, setAlerts] = useState<NurseAlert[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/alerts");
        if (!res.ok) throw new Error();
        const data = (await res.json()) as NurseAlert[];
        if (alive) {
          setAlerts(data);
          setError(false);
        }
      } catch {
        if (alive) setError(true);
      }
    };
    void load();
    const t = window.setInterval(load, 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const ack = async (id: string) => {
    await fetch(`/api/alerts/${id}/ack`, { method: "POST" });
    setAlerts((cur) => cur.map((a) => (a.id === id ? { ...a, status: "acknowledged" } : a)));
  };

  return (
    <div className="nurse-page">
      <header className="nurse-head">
        <a className="brand" href="#/">
          HumanLoop
          <Logo />
        </a>
        <span className="nurse-badge">
          <Icon name="bell" size={16} /> Nurse station · {alerts.filter((a) => a.status === "new").length} new
        </span>
      </header>

      <main className="nurse-list">
        {error && <p className="voice-note">Can’t reach the server. Run `npm run dev` and refresh.</p>}
        {!error && alerts.length === 0 && <p className="nurse-empty">No alerts yet. They appear here when the voice assistant notifies the nurse.</p>}
        {alerts.map((a) => (
          <article className={`alert-card ${a.urgency} ${a.status}`} key={a.id}>
            <div className="alert-top">
              <span className="alert-urgency">{a.urgency}</span>
              <time>{new Date(a.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            </div>
            <h3>
              {a.patient}: {a.reason}
            </h3>
            <p>{a.summary}</p>
            {a.requestedAction && (
              <p className="alert-action">
                <b>Requested:</b> {a.requestedAction}
              </p>
            )}
            {a.photoDescription && (
              <p className="alert-photo">
                <b>Photo:</b> {a.photoDescription}
              </p>
            )}
            {a.transcript.length > 0 && (
              <details>
                <summary>Transcript</summary>
                <ul>
                  {a.transcript.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </details>
            )}
            <button type="button" disabled={a.status === "acknowledged"} onClick={() => ack(a.id)}>
              {a.status === "acknowledged" ? "Acknowledged ✓" : "Acknowledge"}
            </button>
          </article>
        ))}
      </main>
    </div>
  );
}
