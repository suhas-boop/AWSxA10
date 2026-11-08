import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { Logo } from "./Logo";
import { useApp } from "../state";
import type { IconName } from "../types";

const tabs: { to: string; label: string; icon: IconName }[] = [
  { to: "/", label: "Home", icon: "home" },
  { to: "/routine", label: "Routine", icon: "check" },
  { to: "/reminders", label: "Reminders", icon: "clock" },
  { to: "/consent", label: "Consent", icon: "user" },
];

export function Shell({ route, children }: { route: string; children: ReactNode }) {
  const { consentChoice, consentOpen, setConsentOpen, chooseConsent } = useApp();

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#/" aria-label="HumanLoop home">
          <span>HumanLoop</span>
          <Logo />
        </a>
        <div className="profile-chip" aria-label="Patient profile">
          <span className="profile-copy">
            <b>Alice</b>
            <small>My health journey</small>
          </span>
          <span className="avatar">A</span>
        </div>
      </header>

      <main id="top">{children}</main>

      <nav className="bottom-nav" aria-label="Main navigation">
        {tabs.map((t) => (
          <a key={t.to} href={`#${t.to}`} className={route === t.to ? "active" : ""}>
            <Icon name={t.icon} size={25} />
            <span>{t.label}</span>
          </a>
        ))}
      </nav>

      {consentChoice && !consentOpen && route === "/" && (
        <button className="consent-toast" type="button" onClick={() => setConsentOpen(true)}>
          <Icon name="shield" size={20} />
          {consentChoice === "accepted" ? "Care sharing is on" : "Care sharing is off"}
        </button>
      )}

      {consentOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="consent-modal" role="dialog" aria-modal="true" aria-labelledby="consent-title">
            <button className="modal-close" type="button" aria-label="Close consent dialog" onClick={() => setConsentOpen(false)}>
              ×
            </button>
            <div className="consent-art" aria-hidden="true">
              <div className="shield-shape">
                <Icon name="heart" size={35} />
              </div>
              <span className="spark one">✦</span>
              <span className="spark two">✦</span>
            </div>
            <p className="section-kicker">YOUR PRIVACY, YOUR CHOICE</p>
            <h2 id="consent-title">Share your health journey?</h2>
            <p className="consent-description">
              Allow HumanLoop to share your routine and health updates with your trusted care circle.
            </p>
            <div className="sharing-row">
              <span className="mini-avatar doctor">DM</span>
              <div>
                <strong>Dr. Miller </strong>
                <small>Your registered nurse</small>
              </div>
            </div>
            <ul className="consent-list">
              <li>
                <Icon name="check" size={18} /> See completed routines and check-ins
              </li>
              <li>
                <Icon name="check" size={18} /> Receive an alert if you miss important medication
              </li>
              <li>
                <Icon name="check" size={18} /> Your information stays private and secure
              </li>
            </ul>
            <button className="primary-consent" type="button" onClick={() => chooseConsent("accepted")}>
              Yes, share with my care circle
            </button>
            <button className="secondary-consent" type="button" onClick={() => chooseConsent("declined")}>
              Not right now
            </button>
            <p className="consent-footnote">You can change this anytime in Consent.</p>
          </section>
        </div>
      )}
    </div>
  );
}
