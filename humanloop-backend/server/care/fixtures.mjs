export const ORG = 'carealong-demo';
export const orgPK = `ORG#${ORG}`;
export const residentPK = id => `${orgPK}#RESIDENT#${id}`;
export const TOOL_NAMES = ['get_checkin_context', 'propose_follow_up', 'create_review_task', 'get_review_status'];
export const residents = [
  { id: 'margaret', name: 'Margaret', age: 78, room: 'Willow · 204', scenario: 'cough', conditions: ['heart failure'], medications: ['Synthetic care plan on file'], assignedNurse: 'sam', assignedCaregiver: 'carla' },
  { id: 'daniel', name: 'Daniel', age: 74, room: 'Willow · 208', scenario: 'isolation', conditions: ['hypertension'], medications: [], assignedNurse: 'lee', assignedCaregiver: null },
  { id: 'robert', name: 'Robert', age: 81, room: 'Maple · 102', scenario: 'head-injury', conditions: ['atrial fibrillation'], medications: ['apixaban (anticoagulant)'], assignedNurse: 'sam', assignedCaregiver: null },
  { id: 'grace', name: 'Grace', age: 76, room: 'Maple · 106', scenario: 'pharmacy', conditions: [], medications: ['Medication details unavailable'], assignedNurse: 'sam', assignedCaregiver: 'carla' },
];
export const people = [
  ...residents.map(resident => ({ username: resident.id, role: 'resident', name: resident.name, residentId: resident.id, assignments: [resident.id] })),
  { username: 'sam', role: 'nurse', name: 'Sam Rivera', assignments: ['margaret', 'robert', 'grace'] },
  { username: 'lee', role: 'nurse', name: 'Lee Chen', assignments: ['daniel'] },
  { username: 'carla', role: 'caregiver', name: 'Carla Morgan', assignments: ['margaret', 'grace'] },
  { username: 'admin', role: 'admin', name: 'Alex · administrator', assignments: [] },
];
export async function seedFixtures(store, subjects) {
  for (const resident of residents) {
    const pk = residentPK(resident.id);
    const record = { ...resident, pk, sk: 'CONTEXT', type: 'ResidentContext', version: 1, synthetic: true,
      source: 'CareAlong synthetic fixture v2', source_ref: `fixture:${resident.id}:v2`, plan_version: 'demo-v2',
      effective_at: '2026-11-07T00:00:00.000Z', verified_at: new Date().toISOString(), clinical_review: 'Not clinically approved' };
    if (!await store.get(pk, 'CONTEXT')) await store.put(record);
  }
  for (const person of people) {
    const subject = subjects[person.username];
    if (!subject) continue;
    const item = { ...person, subject, pk: orgPK, sk: `MEMBER#${subject}`, type: 'Membership', version: 1, active: true };
    if (!await store.get(orgPK, item.sk)) await store.put(item);
  }
}
