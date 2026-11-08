"""Patient companion devices: pairing, patient binding, PIN, loss and discharge.

A companion agent runs on a tablet or display in the patient's home. Its identity is:

  device workload key (generated on the device, never leaves it)
  + AgenticPrint of the companion build
  + a binding to exactly ONE patient, set by an RN at pairing time
  + a short PIN the patient (or their caregiver) knows

Pairing is a two-step, human-initiated ceremony:
  1. a licensed clinician on the patient's care team starts pairing -> one-time 6-digit code (10 min)
  2. the device redeems the code with its public key and the PIN chosen by the patient

The companion never receives staff credentials and never sees another patient's data.
"""
from __future__ import annotations

import secrets
import threading
from dataclasses import asdict, dataclass, field

from .audit import AuditLog
from .crypto import hash_password, new_id, now, verify_password
from .directory import AuthError, WorkforceDirectory
from .revocation import RevocationRegistry
from .workload import AgentRuntime, WorkloadRegistry

COMPANION_TOOLS = ["my.schedule", "my.care_plan", "my.med_reminders", "my.messages", "my.report_symptom"]
COMPANION_MODEL = "llm://patient-companion/v1"
COMPANION_PROMPT = (
    "You are a gentle companion on a hospice patient's home tablet. Speak in short, warm, plain "
    "sentences suitable for an older adult. You can only see information about the one patient this "
    "device belongs to. Never discuss other patients. For anything urgent, tell them to call the "
    "hospice 24-hour nurse line right away. Pass symptoms on to the care team using the report tool."
)
PAIRING_ROLES = {"rn_case_manager", "medical_director", "social_worker"}
PAIRING_TTL = 600
MAX_PIN_ATTEMPTS = 5


class DeviceError(Exception):
    pass


@dataclass
class Device:
    device_id: str
    agent_id: str
    patient_id: str
    label: str
    paired_by: str
    pin_hash: str
    status: str = "active"  # active | locked | lost | discharged
    failed_pins: int = 0
    paired_at: int = field(default_factory=now)
    last_used: int | None = None

    def public(self) -> dict:
        d = asdict(self)
        d.pop("pin_hash")
        return d


def companion_runtime(device_id: str, tenant: str) -> AgentRuntime:
    """What the device itself would construct: a fresh key and the companion build manifest."""
    return AgentRuntime(f"agt_companion_{device_id[-8:]}", tenant, COMPANION_MODEL, COMPANION_PROMPT,
                        COMPANION_TOOLS)


class DeviceRegistry:
    def __init__(self, directory: WorkforceDirectory, care_teams, workloads: WorkloadRegistry,
                 revocations: RevocationRegistry, audit: AuditLog, tenant: str):
        self.directory = directory
        self.care_teams = care_teams
        self.workloads = workloads
        self.revocations = revocations
        self.audit = audit
        self.tenant = tenant
        self._pending: dict[str, dict] = {}
        self._devices: dict[str, Device] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------- pairing
    def start_pairing(self, staff_id_token: str, patient_id: str, label: str) -> dict:
        try:
            staff = self.directory.verify(staff_id_token)
        except AuthError as exc:
            raise DeviceError(f"clinician not authenticated: {exc}") from exc
        if staff["role"] not in PAIRING_ROLES:
            self.audit.append("device.pairing", "deny", sponsor=staff["sub"], patient=patient_id,
                              reason="role may not pair patient devices")
            raise DeviceError("only an RN, physician or social worker may pair a patient device")
        if not self.care_teams.is_member(patient_id, staff["sub"]):
            self.audit.append("device.pairing", "deny", sponsor=staff["sub"], patient=patient_id,
                              reason="not on care team")
            raise DeviceError(f"{staff['sub']} is not on {patient_id}'s care team")
        code = f"{secrets.randbelow(10**6):06d}"
        device_id = new_id("dev")
        with self._lock:
            self._pending[code] = {"patient_id": patient_id, "label": label, "staff": staff["sub"],
                                   "device_id": device_id, "exp": now() + PAIRING_TTL}
        self.audit.append("device.pairing", "allow", sponsor=staff["sub"], patient=patient_id,
                          reason=f"pairing code issued for '{label}' (10 min, one use)")
        return {"pairing_code": code, "device_id": device_id, "expires_in": PAIRING_TTL}

    def complete_pairing(self, code: str, device_runtime: AgentRuntime, pin: str) -> Device:
        with self._lock:
            p = self._pending.pop(code, None)
        if not p or p["exp"] < now():
            self.audit.append("device.pairing", "deny", reason="invalid or expired pairing code")
            raise DeviceError("invalid or expired pairing code")
        if not (pin.isdigit() and 4 <= len(pin) <= 6):
            raise DeviceError("PIN must be 4 to 6 digits")
        reg = self.workloads.register(device_runtime.registration(
            f"Companion · {p['label']}", sponsor_groups=["patient_companion"], max_tools=COMPANION_TOOLS))
        dev = Device(p["device_id"], reg.agent_id, p["patient_id"], p["label"], p["staff"], hash_password(pin))
        with self._lock:
            self._devices[dev.device_id] = dev
        self.audit.append("device.paired", "allow", agent=reg.agent_id, patient=dev.patient_id,
                          print=reg.print_id, actor=p["staff"], reason=f"bound to {dev.patient_id}")
        return dev

    # ------------------------------------------------------------- runtime checks
    def by_agent(self, agent_id: str) -> Device | None:
        with self._lock:
            return next((d for d in self._devices.values() if d.agent_id == agent_id), None)

    def get(self, device_id: str) -> Device | None:
        with self._lock:
            return self._devices.get(device_id)

    def all(self) -> list[Device]:
        with self._lock:
            return list(self._devices.values())

    def active_for_patient(self, patient_id: str) -> list[Device]:
        with self._lock:
            return [d for d in self._devices.values() if d.patient_id == patient_id and d.status == "active"]

    def check_pin(self, dev: Device, pin: str) -> bool:
        if dev.status != "active":
            return False
        if verify_password(pin, dev.pin_hash):
            dev.failed_pins = 0
            dev.last_used = now()
            return True
        dev.failed_pins += 1
        if dev.failed_pins >= MAX_PIN_ATTEMPTS:
            dev.status = "locked"
            self.revocations.revoke("agent", dev.agent_id, "too many wrong PINs - re-pair at next visit",
                                    "device-lockout")
        self.audit.append("device.pin", "deny", agent=dev.agent_id, patient=dev.patient_id,
                          reason=f"wrong PIN ({dev.failed_pins}/{MAX_PIN_ATTEMPTS})")
        return False

    # ------------------------------------------------------------- loss / discharge
    def mark_lost(self, device_id: str, actor: str) -> Device:
        dev = self.get(device_id)
        if not dev:
            raise DeviceError("unknown device")
        dev.status = "lost"
        self.revocations.revoke("agent", dev.agent_id, "device reported lost", actor)
        return dev

    def discharge_patient(self, patient_id: str, reason: str, actor: str) -> list[str]:
        """Discharge, revocation of the hospice benefit, or death: every device for the patient stops."""
        hits = []
        with self._lock:
            for d in self._devices.values():
                if d.patient_id == patient_id and d.status == "active":
                    d.status = "discharged"
                    hits.append(d.device_id)
        self.revocations.revoke("sponsor", f"patient:{patient_id}", reason, actor)
        return hits
