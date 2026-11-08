import { Icon } from "../components/Icon";
import { useApp, type Prefs } from "../state";

const rows: { key: keyof Prefs; title: string; note: string }[] = [
  { key: "shareRoutine", title: "Share my routine", note: "Dr. Miller can see which tasks you completed" },
  { key: "shareCheckIns", title: "Share my check-ins", note: "Your daily check-in answers and conversations" },
  { key: "medicationAlerts", title: "Missed medication alerts", note: "Alert your nurse if you miss an important medicine" },
  { key: "voice", title: "Voice conversations", note: "Talk to Dr. Miller using your microphone" },
  { key: "camera", title: "Photos", note: "Share photos, for example a swollen ankle, with your nurse" },
];

export default function Consent() {
  const { prefs, setPref, consentChoice, setConsentOpen } = useApp();
  return (
    <section className="content-section" aria-labelledby="consent-page-title">
      <div className="section-heading">
        <div>
          <p className="section-kicker">YOUR PRIVACY, YOUR CHOICE</p>
          <h2 id="consent-page-title">Consent</h2>
        </div>
      </div>

      <div className="care-note">
        <Icon name="shield" size={28} />
        <div>
          <strong>{consentChoice === "declined" ? "Care sharing is off" : "Care sharing is on"}</strong>
          <span>Dr. Miller, your registered nurse, only sees what you allow below.</span>
        </div>
      </div>

      <div className="toggle-list">
        {rows.map((r) => (
          <label className="toggle-row" key={r.key}>
            <div>
              <strong>{r.title}</strong>
              <span>{r.note}</span>
            </div>
            <input type="checkbox" role="switch" checked={prefs[r.key]} onChange={(e) => setPref(r.key, e.target.checked)} />
            <i aria-hidden="true"></i>
          </label>
        ))}
      </div>

      <button className="secondary-consent" type="button" onClick={() => setConsentOpen(true)}>
        Review the sharing summary
      </button>
    </section>
  );
}
