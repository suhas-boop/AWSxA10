export const PROTOCOL = 'carealong-demo-2026-11-08.v3';
export const EMERGENCY = 'Demo emergency route: seek immediate emergency help. In the United States, call 911 or ask someone nearby to call. This prototype has not contacted emergency services.';
export const URGENT = 'Demo urgent route: seek urgent medical assessment after the reported head injury. Do not wait for an inbox acknowledgment. CareAlong cannot assess an injury or arrange emergency care.';
export const references = {
  cough: 'https://www.heart.org/en/health-topics/heart-failure/living-with-heart-failure-and-managing-advanced-hf/physical-changes-to-report-for-heart-failure',
  emergency: 'https://www.mayoclinic.org/diseases-conditions/heart-failure/symptoms-causes/syc-20373142',
  head: 'https://www.nice.org.uk/guidance/ng232/chapter/recommendations',
};

// Intentionally narrow extraction for synthetic fixtures. Ambiguous/free-form medical content
// requires clarification; this is not a general clinical triage classifier.
export function yesNo(text) {
  const s = text.trim().toLowerCase().replace(/[.!?]+$/g, '');
  if (/not sure|unsure|maybe|perhaps/.test(s) || (/\byes\b/.test(s) && /\bno\b/.test(s))) return null;
  if (/^(no|nope|not me|that was (the )?tv|it was (the )?tv|it came from (the )?tv)(\b|$)/.test(s)) return false;
  if (/^(yes|yeah|yep|it was me|that was me|i did|it is new|it's new)(\b|$)/.test(s)) return true;
  return null;
}
// These phrases answer only the CURRENT severe-breathing question. A denial of
// severity must not be treated as a denial of discomfort or of all symptoms.
export function breathingAnswer(text) {
  const s = text.trim().toLowerCase().replaceAll('’', "'").replace(/[.!]+$/g, '');
  if (/\?|\b(unsure|maybe|perhaps)\b|not sure|don't know|do not know|\b(but|and|or)\s*$/.test(s)) return null;
  const mildDiscomfort = "(?:[, ]+(?:but )?(?:it's |it is |i'm |i am )?(?:a little(?: bit)?|a bit|slightly|somewhat) uncomfortable)?";
  if (new RegExp("^(?:it's |it is |that's |that is )?not severe" + mildDiscomfort + '$').test(s)) return false;
  if (/^(?:i'm |i am )?breathing (?:fine|normally|comfortably|okay|ok)$/.test(s)) return false;
  if (/^i (?:don't|do not) have severe (?:difficulty|trouble) breathing$/.test(s)) return false;
  if (/^i can breathe (?:fine|normally|comfortably|okay|ok)$/.test(s)) return false;
  if (/^(?:it's|it is) severe$/.test(s)) return true;
  return yesNo(s);
}
export function explicitEmergency(text) {
  const s = text.trim().toLowerCase();
  // A hypothetical question is not a personal symptom report. A TV mention elsewhere
  // must not suppress an explicit personal danger statement.
  if (/^(what if|if|for example|an example)\b/.test(s) || /^(the )?(tv|television|someone|he|she) (said|says)\b/.test(s)) return false;
  return /\bi (can't|cannot|can not) breathe\b|\bi (am having|have) severe (trouble|difficulty) breathing\b|\bi (have|am having) (severe )?chest pain\b/.test(s);
}
export function detectTopic(text) {
  const s = text.toLowerCase();
  if (/\bi (fell|fall|bumped|hit)\b/.test(s) && /\b(my )?head\b/.test(s)) return 'head-injury';
  if (/pharmacy|pick up (my )?(medicine|medication)|collect (my )?(medicine|medication)/.test(s) && /couldn't|could not|can't|cannot|help|no ride|didn't|did not/.test(s)) return 'pharmacy';
  if (/\b(i have|i've had|my|i am|i'm)\b.*\bcough/.test(s)) return 'cough';
  return null;
}
export function questionFor(incident) {
  if (!incident) return 'How has your day been?';
  if (incident.route === 'emergency') return EMERGENCY;
  if (incident.clarification_needed && incident.clarification_attempts >= 2) return 'I could not confirm that answer. Use the Yes or No buttons below, or choose human help.';
  if (incident.clarification_needed && incident.phase === 'breathing') return 'I heard your answer, but could not tell whether the breathing difficulty is severe. You can say yes or no, or use the buttons below.';
  switch (incident.phase) {
    case 'source': return 'Was that cough from you, or from something nearby?';
    case 'new': return 'Is the cough new or worse than usual?';
    case 'breathing': return 'Are you having severe difficulty breathing right now?';
    case 'head-confirm': return 'Did you hit your head when you fell or bumped it?';
    case 'pickup': return 'Would you like help collecting your medication?';
    case 'supply': return 'Will you run out of medication before you can collect it?';
    case 'ready': return incident.route === 'urgent' ? URGENT : 'Would you like me to prepare a request for your care team to review? You can review exactly what will be shared.';
    case 'dismissed': return 'Thank you for clarifying. I have not added that sound as your symptom.';
    case 'handed-off': return 'Your request is with your care team. Their acknowledgment and next step will appear here.';
    default: return 'Please clarify that in your own words, or choose an answer below.';
  }
}

export function advance(incident, text) {
  const next = { ...incident, open_questions: [] };
  if (explicitEmergency(text)) return { ...next, route: 'emergency', state: 'CONFIRMED_CONCERN', phase: 'emergency' };
  if (!['source', 'new', 'breathing', 'head-confirm', 'pickup', 'supply'].includes(next.phase)) return next;
  const answer = next.phase === 'breathing' ? breathingAnswer(text) : yesNo(text);
  if (answer === null) return { ...next, clarification_needed: true, clarification_attempts: (next.clarification_attempts || 0) + 1 };
  next.clarification_needed = false;
  next.clarification_attempts = 0;
  if (['source', 'head-confirm', 'pickup'].includes(next.phase) && !answer) return { ...next, state: 'DISMISSED_BY_USER', phase: 'dismissed', route: 'clarify', symptom_confirmed: false };
  if (next.phase === 'source') return { ...next, state: 'CLARIFYING', phase: 'new', symptom_confirmed: true };
  if (next.phase === 'new') return { ...next, changed: answer, phase: 'breathing' };
  if (next.phase === 'breathing') return { ...next, severe_breathing: answer, state: 'CONFIRMED_CONCERN', phase: answer ? 'emergency' : 'ready', route: answer ? 'emergency' : 'clinical-review' };
  if (next.phase === 'head-confirm') return { ...next, symptom_confirmed: true, phase: 'ready', route: 'urgent', state: 'CONFIRMED_CONCERN' };
  if (next.phase === 'pickup') return { ...next, phase: 'supply', assistance_confirmed: true };
  if (next.phase === 'supply') return { ...next, phase: 'ready', route: 'coordinate', near_term_supply_concern: answer, state: 'CONFIRMED_CONCERN' };
  return next;
}
