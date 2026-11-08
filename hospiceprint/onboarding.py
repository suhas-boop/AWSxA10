"""Regulated staff onboarding, offboarding and continuous compliance.

A hospice staff member gets no account -- and so can never sponsor an AI agent --
until every gate below passes. Each gate cites the requirement it implements.

The verification sources are mocks of what a hospice actually calls:
  * state board / Nursys-style primary-source license verification
  * OIG LEIE and SAM.gov exclusion screening
  * a background-check vendor
  * the learning management system (HIPAA + orientation + competency)
  * HR e-signature for agreements
All data here is synthetic.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

from .audit import AuditLog
from .crypto import hash_password, new_totp_secret
from .directory import LICENSED_ROLES, ROLES, StaffMember, WorkforceDirectory
from .revocation import RevocationRegistry

REQUIRED_TRAINING = ["hipaa_privacy", "hipaa_security", "hospice_orientation"]
ROLE_COMPETENCY = {
    "hospice_aide": "aide_competency_418_76",
    "rn_case_manager": "rn_hospice_competency",
    "medical_director": None,
    "social_worker": None,
    "billing_specialist": "billing_compliance",
    "privacy_officer": None,
}
LICENSE_TYPE_FOR_ROLE = {"medical_director": "MD", "rn_case_manager": "RN", "social_worker": "LCSW"}
LICENSE_WARNING_DAYS = 30

GATES = [
    ("identity", "Identity proofing", "NIST SP 800-63A (IAL2)"),
    ("license", "License primary-source verification", "42 CFR 418.114(a)"),
    ("exclusion", "OIG LEIE + SAM exclusion screening", "SSA §1128 / OIG guidance"),
    ("background", "Criminal background check", "42 CFR 418.114(d)"),
    ("training", "HIPAA privacy + security training", "45 CFR 164.530(b), 164.308(a)(5)"),
    ("competency", "Role competency", "42 CFR 418.76 (aides)"),
    ("agreements", "Confidentiality + acceptable-use agreement", "45 CFR 164.308(a)(3)"),
    ("mfa", "MFA enrollment", "45 CFR 164.312(d)"),
    ("role", "Role assignment (minimum necessary)", "45 CFR 164.308(a)(4), 164.514(d)"),
]


@dataclass
class VerificationSources:
    licenses: dict[str, dict] = field(default_factory=dict)          # number -> record
    exclusions: set[tuple[str, str]] = field(default_factory=set)    # (full name, dob)
    background: dict[str, str] = field(default_factory=dict)         # applicant_id -> clear|consider|pending
    training: dict[str, set[str]] = field(default_factory=dict)      # applicant_id -> completed modules
    agreements: dict[str, set[str]] = field(default_factory=dict)    # applicant_id -> signed docs


@dataclass
class Application:
    applicant_id: str
    username: str
    full_name: str
    dob: str
    role: str
    identity_verified: bool
    license_number: str | None = None
    initial_password: str = ""


class OnboardingService:
    def __init__(self, directory: WorkforceDirectory, sources: VerificationSources,
                 revocations: RevocationRegistry, audit: AuditLog, care_teams=None):
        self.directory = directory
        self.sources = sources
        self.revocations = revocations
        self.audit = audit
        self.care_teams = care_teams
        self.totp_secrets: dict[str, str] = {}  # demo only: handed to the staff member's authenticator

    # ------------------------------------------------------------- gates
    def _check(self, gate: str, app: Application, today: dt.date) -> tuple[str, str]:
        s = self.sources
        if gate == "identity":
            return ("pass", "documents verified in person by HR") if app.identity_verified \
                else ("fail", "identity documents not verified")
        if gate == "license":
            if app.role not in LICENSED_ROLES:
                return "pass", "no state license required for this role"
            rec = s.licenses.get(app.license_number or "")
            if not rec:
                return "fail", f"license {app.license_number or '<none>'} not found at the board"
            if rec["name"] != app.full_name:
                return "fail", "license holder name does not match applicant"
            if rec["type"] != LICENSE_TYPE_FOR_ROLE[app.role]:
                return "fail", f"{rec['type']} license does not qualify for {ROLES[app.role]}"
            if rec["status"] != "active":
                return "fail", f"license status is {rec['status']}"
            exp = dt.date.fromisoformat(rec["expires"])
            if exp < today:
                return "fail", f"license expired {rec['expires']}"
            return "pass", f"{rec['type']} {app.license_number} ({rec['state']}) active, expires {rec['expires']}"
        if gate == "exclusion":
            if (app.full_name, app.dob) in s.exclusions:
                return "fail", "match on exclusion list - cannot be employed in a federally funded program"
            return "pass", "no match on OIG LEIE or SAM"
        if gate == "background":
            r = s.background.get(app.applicant_id, "pending")
            return {"clear": ("pass", "clear"), "consider": ("fail", "adverse finding - routed to HR review"),
                    "pending": ("pending", "awaiting vendor result")}[r]
        if gate == "training":
            missing = [m for m in REQUIRED_TRAINING if m not in s.training.get(app.applicant_id, set())]
            return ("fail", f"incomplete: {', '.join(missing)}") if missing else ("pass", "all modules complete")
        if gate == "competency":
            need = ROLE_COMPETENCY.get(app.role)
            if not need:
                return "pass", "covered by licensure"
            return ("pass", f"{need} passed") if need in s.training.get(app.applicant_id, set()) \
                else ("fail", f"{need} not completed")
        if gate == "agreements":
            ok = {"confidentiality", "acceptable_use"} <= s.agreements.get(app.applicant_id, set())
            return ("pass", "signed") if ok else ("fail", "confidentiality / acceptable-use not signed")
        raise ValueError(gate)

    def onboard(self, app: Application, actor: str = "hr-onboarding",
                today: dt.date | None = None) -> dict:
        today = today or dt.date.today()
        if app.role not in ROLES:
            raise ValueError(f"unknown role {app.role}")
        results, blocked = [], False
        for gate, label, ref in GATES:
            if gate in ("mfa", "role"):
                status, detail = ("skipped", "not reached") if blocked else ("pass", "")
                if not blocked and gate == "mfa":
                    detail = "TOTP authenticator enrolled"
                if not blocked and gate == "role":
                    detail = f"{ROLES[app.role]}; entitlements from role catalog"
            elif blocked:
                status, detail = "skipped", "not reached"
            else:
                status, detail = self._check(gate, app, today)
                if status != "pass":
                    blocked = True
            results.append({"gate": gate, "label": label, "ref": ref, "status": status, "detail": detail})
            self.audit.append("onboarding.gate", {"pass": "allow", "fail": "deny"}.get(status, "info"),
                              staff=app.username, gate=gate, reason=f"{status}: {detail}", actor=actor)

        lic = None
        if app.license_number and app.license_number in self.sources.licenses:
            r = self.sources.licenses[app.license_number]
            lic = {"number": app.license_number, "type": r["type"], "state": r["state"], "expires": r["expires"]}
        member = StaffMember(app.username, app.full_name, app.role, f"EMP-{app.applicant_id[-4:]}",
                             license=lic, onboarding=results)
        if blocked:
            failed = next(r for r in results if r["status"] in ("fail", "pending"))
            member.status = "pending"
            member.status_reason = f"onboarding blocked at {failed['label']}: {failed['detail']}"
            self.directory.upsert(member)
            self.audit.append("onboarding.complete", "deny", staff=app.username, reason=member.status_reason)
            return {"provisioned": False, "staff": member.public()}

        secret = new_totp_secret()
        self.totp_secrets[app.username] = secret
        member.password_hash = hash_password(app.initial_password)
        member.totp_secret = secret
        member.status, member.status_reason = "active", "onboarding complete"
        self.directory.upsert(member)
        self.audit.append("onboarding.complete", "allow", staff=app.username, role=app.role,
                          reason="all gates passed; account provisioned")
        return {"provisioned": True, "staff": member.public()}

    # ------------------------------------------------------------- offboarding
    def offboard(self, username: str, reason: str, actor: str = "hr-offboarding") -> dict:
        """Termination procedures, 45 CFR 164.308(a)(3)(ii)(C): one action cuts every path."""
        self.directory.set_status(username, "terminated", reason, actor)
        self.revocations.revoke("sponsor", username, f"staff terminated: {reason}", actor)
        removed = self.care_teams.remove_member_everywhere(username, actor) if self.care_teams else []
        return {"username": username, "status": "terminated", "removed_from_care_teams": removed}

    # ------------------------------------------------------------- continuous
    def compliance_sweep(self, today: dt.date | None = None, actor: str = "compliance-sweep") -> list[dict]:
        """Nightly re-check of active staff: licenses lapse and exclusions appear after hire."""
        today = today or dt.date.today()
        actions = []
        for m in self.directory.all():
            if m.status != "active":
                continue
            problem = None
            if m.role in LICENSED_ROLES and m.license:
                rec = self.sources.licenses.get(m.license["number"], {})
                if rec.get("status") != "active":
                    problem = f"license now {rec.get('status', 'missing')} at the board"
                elif dt.date.fromisoformat(rec["expires"]) < today:
                    problem = f"license expired {rec['expires']}"
                else:
                    m.license["expires"] = rec["expires"]
                    days = (dt.date.fromisoformat(rec["expires"]) - today).days
                    if days <= LICENSE_WARNING_DAYS:
                        actions.append({"username": m.username, "action": "warn",
                                        "reason": f"license expires in {days} days"})
            dob = next((d for (n, d) in self.sources.exclusions if n == m.display_name), None)
            if dob is not None:
                problem = "new match on exclusion list"
            if problem:
                self.directory.set_status(m.username, "suspended", problem, actor)
                self.revocations.revoke("sponsor", m.username, f"staff suspended: {problem}", actor)
                actions.append({"username": m.username, "action": "suspend", "reason": problem})
        return actions
