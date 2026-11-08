"""Hospice tool catalog, role entitlements, care-team relationships, and per-call policy.

Authorization is deny-by-default and layered:

  grant time   tools = requested ∩ agent ceiling ∩ sponsor-role entitlements,
               and every tool must allow the declared purpose of use
  call time    tool in grant · purpose allowed · patient on the sponsor's care team
               (or an audited break-glass) · tool-specific rules (42 CFR Part 2
               consent, family-contact authorization, prescriber-only actions)
  response     minimum necessary: fields the sponsor's role does not need are
               stripped before the result reaches the agent
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Callable

from .audit import AuditLog

# HL7 PurposeOfUse codes
TREAT, ETREAT, HPAYMT, HOPERAT, PATRQT = "TREAT", "ETREAT", "HPAYMT", "HOPERAT", "PATRQT"
PURPOSES = {TREAT: "Treatment", ETREAT: "Emergency treatment (break-glass)",
            HPAYMT: "Payment", HOPERAT: "Healthcare operations",
            PATRQT: "Patient requested (patient's own companion device)"}


@dataclass
class Decision:
    allow: bool
    reason: str
    rule: str
    break_glass: bool = False


@dataclass
class ToolSpec:
    name: str
    description: str
    risk: str
    purposes: set[str]
    input_schema: dict
    patient_scoped: bool = True
    constraint: Callable[[dict, dict, "PolicyEngine"], Decision | None] | None = None


# ----------------------------------------------------------------- care teams

class CareTeamRegistry:
    """Who is on each patient's interdisciplinary group (42 CFR 418.56). Checked live."""

    def __init__(self, audit: AuditLog):
        self.audit = audit
        self._teams: dict[str, set[str]] = {}
        self._lock = threading.Lock()

    def assign(self, patient_id: str, username: str, actor: str = "clinical-manager"):
        with self._lock:
            self._teams.setdefault(patient_id, set()).add(username)
        self.audit.append("careteam.assign", "info", staff=username, patient=patient_id, actor=actor)

    def remove(self, patient_id: str, username: str, actor: str = "clinical-manager"):
        with self._lock:
            self._teams.get(patient_id, set()).discard(username)
        self.audit.append("careteam.remove", "info", staff=username, patient=patient_id, actor=actor)

    def remove_member_everywhere(self, username: str, actor: str) -> list[str]:
        with self._lock:
            hits = [p for p, team in self._teams.items() if username in team]
            for p in hits:
                self._teams[p].discard(username)
        for p in hits:
            self.audit.append("careteam.remove", "info", staff=username, patient=p, actor=actor)
        return hits

    def is_member(self, patient_id: str, username: str) -> bool:
        with self._lock:
            return username in self._teams.get(patient_id, set())

    def caseload(self, username: str) -> list[str]:
        with self._lock:
            return sorted(p for p, t in self._teams.items() if username in t)


# ----------------------------------------------------------------- constraints

def _part2_consent(claims, args, engine) -> Decision | None:
    pid = args.get("patient_id")
    if not engine.ehr.has_part2_consent(pid):
        return Decision(False, "no 42 CFR Part 2 consent on file for this patient", "part2-consent")
    return None


def _family_authorized(claims, args, engine) -> Decision | None:
    pid, to = args.get("patient_id"), args.get("recipient")
    if not engine.ehr.is_authorized_contact(pid, to):
        return Decision(False, f"'{to}' is not on the patient's authorized contact list",
                        "family-authorization")
    return None


def _visit_window(claims, args, engine) -> Decision | None:
    when = str(args.get("when", ""))
    if len(when) < 10:
        return Decision(False, "visit time required (YYYY-MM-DD HH:MM)", "input-validation")
    return None


def _companion_active(claims, args, engine) -> Decision | None:
    devices = getattr(engine, "devices", None)
    if devices is None or not devices.active_for_patient(args.get("patient_id")):
        return Decision(False, f"no active companion device is paired to {args.get('patient_id')}",
                        "companion-device")
    return None


def default_catalog() -> dict[str, ToolSpec]:
    pid = {"patient_id": {"type": "string"}}
    tools = [
        ToolSpec("patients.get_summary", "Read a patient's hospice summary (filtered by role).", "medium",
                 {TREAT, ETREAT, HPAYMT, HOPERAT},
                 {"type": "object", "properties": pid, "required": ["patient_id"]}),
        ToolSpec("meds.get_list", "Read the active medication profile and allergies.", "medium",
                 {TREAT, ETREAT},
                 {"type": "object", "properties": pid, "required": ["patient_id"]}),
        ToolSpec("visits.schedule", "Schedule a home visit for the care team.", "low",
                 {TREAT, HOPERAT},
                 {"type": "object", "properties": {**pid, "when": {"type": "string"},
                                                   "discipline": {"type": "string"}},
                  "required": ["patient_id", "when"]}, constraint=_visit_window),
        ToolSpec("notes.draft_visit_note", "Draft a visit note for clinician review and e-signature.", "medium",
                 {TREAT},
                 {"type": "object", "properties": {**pid, "observations": {"type": "string"}},
                  "required": ["patient_id"]}),
        ToolSpec("family.send_update", "Send a care update to an authorized family contact.", "medium",
                 {TREAT},
                 {"type": "object", "properties": {**pid, "recipient": {"type": "string"},
                                                   "message": {"type": "string"}},
                  "required": ["patient_id", "recipient"]}, constraint=_family_authorized),
        ToolSpec("records.read_part2", "Read substance use disorder treatment records.", "high",
                 {TREAT, ETREAT},
                 {"type": "object", "properties": pid, "required": ["patient_id"]}, constraint=_part2_consent),
        ToolSpec("meds.order_controlled", "Order a Schedule II controlled substance.", "high",
                 {TREAT},
                 {"type": "object", "properties": {**pid, "drug": {"type": "string"},
                                                   "dose": {"type": "string"}},
                  "required": ["patient_id", "drug"]}),
        # --- orchestrator (RN agent) -> companion agents, mediated by the gateway
        ToolSpec("companion.dispatch", "Send a reminder or check-in question to the patient's companion device.",
                 "medium", {TREAT},
                 {"type": "object", "properties": {**pid, "message": {"type": "string"},
                                                   "kind": {"type": "string", "enum": ["reminder", "checkin"]}},
                  "required": ["patient_id", "message"]}, constraint=_companion_active),
        ToolSpec("inbox.read_reports", "Read symptom reports a patient sent from their companion device.",
                 "medium", {TREAT},
                 {"type": "object", "properties": pid, "required": ["patient_id"]}),
        # --- patient companion (bound to one patient; patient_id is filled from the binding)
        ToolSpec("my.schedule", "Upcoming hospice visits for this patient.", "low", {PATRQT},
                 {"type": "object", "properties": pid}),
        ToolSpec("my.care_plan", "This patient's care plan in plain language.", "low", {PATRQT},
                 {"type": "object", "properties": pid}),
        ToolSpec("my.med_reminders", "This patient's medicine reminders.", "low", {PATRQT},
                 {"type": "object", "properties": pid}),
        ToolSpec("my.messages", "Messages from the care team to this patient.", "low", {PATRQT},
                 {"type": "object", "properties": pid}),
        ToolSpec("my.report_symptom", "Send a symptom report to the care team.", "low", {PATRQT},
                 {"type": "object", "properties": {**pid, "symptom": {"type": "string"},
                                                   "severity_0_10": {"type": "integer"}},
                  "required": ["symptom"]}),
        ToolSpec("billing.submit_claim", "Submit a hospice claim for a benefit period.", "high",
                 {HPAYMT},
                 {"type": "object", "properties": {**pid, "level_of_care": {"type": "string"}},
                  "required": ["patient_id"]}),
    ]
    return {t.name: t for t in tools}


# Role -> tools the role may use (directly or through an agent it sponsors)
ROLE_ENTITLEMENTS = {
    "medical_director": {"patients.get_summary", "meds.get_list", "notes.draft_visit_note",
                         "records.read_part2", "meds.order_controlled", "visits.schedule",
                         "companion.dispatch", "inbox.read_reports"},
    "rn_case_manager": {"patients.get_summary", "meds.get_list", "visits.schedule",
                        "notes.draft_visit_note", "family.send_update", "records.read_part2",
                        "companion.dispatch", "inbox.read_reports"},
    "hospice_aide": {"patients.get_summary", "visits.schedule", "notes.draft_visit_note"},
    "social_worker": {"patients.get_summary", "visits.schedule", "family.send_update",
                      "notes.draft_visit_note"},
    "billing_specialist": {"patients.get_summary", "billing.submit_claim"},
    "privacy_officer": set(),
    "patient_companion": {"my.schedule", "my.care_plan", "my.med_reminders", "my.messages",
                          "my.report_symptom"},
}

# Minimum necessary (45 CFR 164.502(b), 164.514(d)): fields each role may see in a summary
SUMMARY_FIELDS = {
    "medical_director": {"patient_id", "name", "dob", "address", "terminal_diagnosis", "comorbidities",
                         "code_status", "prognosis", "allergies", "attending", "care_plan",
                         "family_contacts", "benefit_period"},
    "rn_case_manager": {"patient_id", "name", "dob", "address", "terminal_diagnosis", "comorbidities",
                        "code_status", "prognosis", "allergies", "attending", "care_plan",
                        "family_contacts", "benefit_period"},
    "hospice_aide": {"patient_id", "name", "address", "code_status", "allergies", "care_plan",
                     "family_contacts"},
    "social_worker": {"patient_id", "name", "address", "terminal_diagnosis", "code_status",
                      "care_plan", "family_contacts"},
    "billing_specialist": {"patient_id", "name", "dob", "terminal_diagnosis", "payer", "benefit_period"},
}

BREAK_GLASS_ROLES = {"rn_case_manager", "medical_director"}


@dataclass
class PolicyEngine:
    catalog: dict[str, ToolSpec]
    care_teams: CareTeamRegistry
    ehr: object
    entitlements: dict[str, set[str]] = field(default_factory=lambda: ROLE_ENTITLEMENTS)
    devices: object = None

    def evaluate(self, claims: dict, tool: str, args: dict) -> Decision:
        spec = self.catalog.get(tool)
        if spec is None:
            return Decision(False, f"unknown tool '{tool}'", "catalog")
        if tool not in claims.get("tools", []):
            return Decision(False, f"'{tool}' is not in this agent's grant", "least-privilege")
        pou = claims.get("pou")
        if pou not in spec.purposes:
            return Decision(False, f"purpose of use {pou} is not permitted for {tool}", "purpose-of-use")
        bg = False
        if claims.get("role") == "patient_companion":
            # Patient binding: the device can only ever act for the patient it was paired to.
            bound = claims.get("patient_binding")
            pid = args.get("patient_id") or bound
            if pid != bound:
                return Decision(False, f"this companion device is bound to {bound}; it cannot access {pid}",
                                "patient-binding")
            args["patient_id"] = bound  # fill it in, so the EHR call is always scoped to the binding
        elif spec.patient_scoped:
            pid = (args or {}).get("patient_id")
            if not pid or not self.ehr.exists(pid):
                return Decision(False, f"unknown patient {pid or '<none>'}", "input-validation")
            if not self.care_teams.is_member(pid, claims["sub"]):
                if claims.get("break_glass"):
                    bg = True
                else:
                    return Decision(False, f"{pid} is not on {claims['sub']}'s care team", "care-relationship")
        if spec.constraint:
            verdict = spec.constraint(claims, args or {}, self)
            if verdict is not None:
                return verdict
        if bg:
            return Decision(True, "BREAK-GLASS access outside care team - flagged for privacy review",
                            "break-glass", break_glass=True)
        if claims.get("role") == "patient_companion":
            return Decision(True, "granted tool, bound to this patient", "allow")
        return Decision(True, "granted tool, purpose and care relationship verified", "allow")

    def minimum_necessary(self, role: str, tool: str, result: dict) -> tuple[dict, list[str]]:
        if tool != "patients.get_summary" or "error" in result:
            return result, []
        allowed = SUMMARY_FIELDS.get(role, {"patient_id"})
        kept = {k: v for k, v in result.items() if k in allowed}
        withheld = sorted(k for k in result if k not in allowed)
        return kept, withheld
