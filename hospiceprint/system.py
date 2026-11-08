"""Wires every component together for the demo tenant, Sunrise Valley Hospice.

Every demo staff member is created by running the real onboarding pipeline against
mock verification sources -- nobody is inserted into the directory by hand.
All people and patients are fictional.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from pathlib import Path

from .audit import AuditLog
from .crypto import totp
from .devices import COMPANION_TOOLS, DeviceRegistry, companion_runtime
from .directory import WorkforceDirectory
from .ehr_mcp import HospiceEHR
from .gateway import MCPGateway
from .grants import GrantService
from .onboarding import Application, OnboardingService, VerificationSources
from .policy import CareTeamRegistry, PolicyEngine, default_catalog
from .revocation import RevocationRegistry
from .workload import AgentRuntime, WorkloadRegistry

TENANT = "sunrise-valley-hospice"

AGENT_ID = "agt_care_coordinator"
AGENT_NAME = "Hospice Care Coordination Agent"
AGENT_MODEL = "llm://care-coordinator/v2"
AGENT_PROMPT = (
    "You are Sunrise Valley Hospice's care coordination assistant and the orchestrator for patient "
    "companion devices. Prepare clinicians for home visits: summarize patients, review medications, "
    "schedule visits, draft visit notes for clinician signature, send updates to authorized family, "
    "read symptom reports from companion devices and send reminders to them. You never prescribe."
)
AGENT_TOOLSET = ["patients.get_summary", "meds.get_list", "visits.schedule", "notes.draft_visit_note",
                 "family.send_update", "records.read_part2", "inbox.read_reports", "companion.dispatch"]
AGENT_CEILING = list(AGENT_TOOLSET)  # never meds.order_controlled, never billing
AGENT_SPONSOR_ROLES = ["rn_case_manager", "medical_director", "hospice_aide", "social_worker"]

_FAR = (dt.date.today() + dt.timedelta(days=500)).isoformat()
_SOON = (dt.date.today() + dt.timedelta(days=20)).isoformat()

# Staff hired at system start. Password is the demo password; TOTP is generated at onboarding.
STAFF = [
    # applicant_id, username, name, dob, role, license
    ("APP-0101", "grace.okafor", "Grace Okafor", "1984-03-02", "rn_case_manager", "RN-CA-884213"),
    ("APP-0102", "alan.brooks", "Dr. Alan Brooks", "1971-11-20", "medical_director", "MD-CA-A55120"),
    ("APP-0103", "maya.chen", "Maya Chen", "1996-06-14", "hospice_aide", None),
    ("APP-0104", "sam.patel", "Sam Patel", "1990-02-08", "billing_specialist", None),
    ("APP-0105", "nina.ross", "Nina Ross", "1979-09-09", "privacy_officer", None),
]
DEMO_PASSWORD = {
    "grace.okafor": "Hospice#RN2026", "alan.brooks": "Hospice#MD2026", "maya.chen": "Hospice#Aide2026",
    "sam.patel": "Hospice#Bill2026", "nina.ross": "Hospice#Priv2026", "jordan.lee": "Hospice#RN2027",
}
# Eleanor's tablet is paired at startup through the real ceremony; PIN is demo-only.
SEED_DEVICE = {"patient_id": "P-1001", "label": "Eleanor's kitchen tablet", "pin": "2468", "by": "grace.okafor"}
CARE_TEAMS = {
    "P-1001": ["grace.okafor", "alan.brooks", "maya.chen"],
    "P-1002": ["grace.okafor", "alan.brooks"],
    "P-1003": ["grace.okafor", "alan.brooks", "maya.chen"],
    "P-2001": ["alan.brooks"],  # another RN's patient
}

# Candidates the console/demo can try to onboard later
CANDIDATES = {
    "jordan.lee": Application("APP-0201", "jordan.lee", "Jordan Lee", "1992-12-01", "rn_case_manager",
                              identity_verified=True, license_number="RN-CA-990172",
                              initial_password="Hospice#RN2027"),
    "tom.reyes": Application("APP-0202", "tom.reyes", "Tom Reyes", "1988-05-17", "hospice_aide",
                             identity_verified=True, initial_password="Hospice#Aide2027"),
    "kelly.nash": Application("APP-0203", "kelly.nash", "Kelly Nash", "1985-08-23", "rn_case_manager",
                              identity_verified=True, license_number="RN-CA-410077",
                              initial_password="Hospice#RN2028"),
}


def demo_sources() -> VerificationSources:
    done = {"hipaa_privacy", "hipaa_security", "hospice_orientation"}
    return VerificationSources(
        licenses={
            "RN-CA-884213": {"name": "Grace Okafor", "type": "RN", "state": "CA", "status": "active", "expires": _FAR},
            "MD-CA-A55120": {"name": "Dr. Alan Brooks", "type": "MD", "state": "CA", "status": "active", "expires": _FAR},
            "RN-CA-990172": {"name": "Jordan Lee", "type": "RN", "state": "CA", "status": "active", "expires": _SOON},
            "RN-CA-410077": {"name": "Kelly Nash", "type": "RN", "state": "CA", "status": "active",
                             "expires": "2025-06-30"},
        },
        exclusions={("Tom Reyes", "1988-05-17")},
        background={a: "clear" for a in ["APP-0101", "APP-0102", "APP-0103", "APP-0104", "APP-0105",
                                         "APP-0201", "APP-0202", "APP-0203"]},
        training={
            "APP-0101": done | {"rn_hospice_competency"}, "APP-0102": set(done),
            "APP-0103": done | {"aide_competency_418_76"}, "APP-0104": done | {"billing_compliance"},
            "APP-0105": set(done), "APP-0201": done | {"rn_hospice_competency"},
            "APP-0202": done | {"aide_competency_418_76"}, "APP-0203": done | {"rn_hospice_competency"},
        },
        agreements={a: {"confidentiality", "acceptable_use"} for a in
                    ["APP-0101", "APP-0102", "APP-0103", "APP-0104", "APP-0105", "APP-0201", "APP-0202", "APP-0203"]},
    )


@dataclass
class System:
    audit: AuditLog
    directory: WorkforceDirectory
    sources: VerificationSources
    onboarding: OnboardingService
    care_teams: CareTeamRegistry
    ehr: HospiceEHR
    catalog: dict
    registry: WorkloadRegistry
    revocations: RevocationRegistry
    grants: GrantService
    gateway: MCPGateway
    agent_runtime: AgentRuntime
    devices: DeviceRegistry
    device_runtimes: dict  # demo only: stands in for the key store on each physical device

    def totp_secret(self, username: str) -> str:
        return self.onboarding.totp_secrets[username]


def build_system(audit_path: str | Path | None = None, token_ttl: int = 300) -> System:
    audit = AuditLog(audit_path)
    directory = WorkforceDirectory("https://login.sunrisevalleyhospice.example", audit)
    revocations = RevocationRegistry(audit)
    care_teams = CareTeamRegistry(audit)
    sources = demo_sources()
    onboarding = OnboardingService(directory, sources, revocations, audit, care_teams)

    for app_id, user, name, dob, role, lic in STAFF:
        res = onboarding.onboard(Application(app_id, user, name, dob, role, identity_verified=True,
                                             license_number=lic, initial_password=DEMO_PASSWORD[user]))
        assert res["provisioned"], res
    for pid, team in CARE_TEAMS.items():
        for user in team:
            care_teams.assign(pid, user)

    ehr = HospiceEHR()
    catalog = default_catalog()
    registry = WorkloadRegistry()
    runtime = AgentRuntime(AGENT_ID, TENANT, AGENT_MODEL, AGENT_PROMPT, AGENT_TOOLSET)
    reg = registry.register(runtime.registration(AGENT_NAME, sponsor_groups=AGENT_SPONSOR_ROLES,
                                                 max_tools=AGENT_CEILING))
    audit.append("workload.registered", "info", agent=AGENT_ID, print=reg.print_id, ceiling=reg.max_tools)

    grants = GrantService("https://iam.sunrisevalleyhospice.example", directory, registry, catalog,
                          revocations, audit, ttl=token_ttl)
    devices = DeviceRegistry(directory, care_teams, registry, revocations, audit, TENANT)
    grants.devices = devices
    policy = PolicyEngine(catalog, care_teams, ehr, devices=devices)
    gateway = MCPGateway(grants, revocations, policy, ehr, audit)
    system = System(audit, directory, sources, onboarding, care_teams, ehr, catalog, registry,
                    revocations, grants, gateway, runtime, devices, {})
    pair_device(system, SEED_DEVICE["by"], SEED_DEVICE["patient_id"], SEED_DEVICE["label"], SEED_DEVICE["pin"])
    return system


def pair_device(system: "System", clinician: str, patient_id: str, label: str, pin: str):
    """The two-step ceremony: clinician starts pairing, the device redeems the code with its own key."""
    staff_token = system.directory.authenticate(clinician, DEMO_PASSWORD[clinician],
                                                totp(system.onboarding.totp_secrets[clinician]))
    started = system.devices.start_pairing(staff_token, patient_id, label)
    runtime = companion_runtime(started["device_id"], TENANT)      # created on the device
    dev = system.devices.complete_pairing(started["pairing_code"], runtime, pin)
    system.device_runtimes[dev.device_id] = runtime
    return dev
