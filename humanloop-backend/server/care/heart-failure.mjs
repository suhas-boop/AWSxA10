// Bounded, fictional demonstration pathway. Not a general clinical classifier.
// Scenario utterances are deliberately NOT included in the model's patient context.
export const HF_PLAN = 'maggie-heart-failure-v1';
export const HF_REFERENCE = 'https://www.heart.org/en/health-topics/heart-failure/living-with-heart-failure-and-managing-advanced-hf/physical-changes-to-report-for-heart-failure';
export function hasHeartFailureDemo(record) {
  const bound = ({ [HF_PLAN]: 'margaret', 'bob-heart-failure-v1': 'robert' })[record?.demo_care_plan?.id];
  return !!bound && record?.synthetic === true && bound === record?.id && record.demo_care_plan.simulated_alerts === true;
}
export function weightChange(record, now = Date.now()) {
  const rows = (record?.measurements || []).filter(m => m.kind === 'weight' && m.unit === 'lb' && m.synthetic === true && Number.isFinite(m.value) && m.source_ref && Number.isFinite(Date.parse(m.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const latest = rows.at(-1), previous = rows.at(-2);
  if (!latest || !previous || now - Date.parse(latest.at) > 86400000 || Date.parse(latest.at) > now || Date.parse(latest.at) - Date.parse(previous.at) > 25 * 3600000 || Date.parse(latest.at) <= Date.parse(previous.at)) return null;
  return { previous, latest, increase_lb: Math.round((latest.value - previous.value) * 10) / 10, hours: Math.round((Date.parse(latest.at) - Date.parse(previous.at)) / 3600000) };
}
export function heartFailureFindings(text, previous = {}) {
  const s = text.toLowerCase().replaceAll('’', "'");
  const findings = {};
  // Uncertain, hypothetical and third-party statements remain verbatim evidence, not affirmative findings.
  const clauses = s.split(/[.!?;]|,?\s+but\s+|\s+and\s+(?=i\b|my\b|both\b)/).map(x => x.trim()).filter(Boolean);
  for (const c of clauses) {
    if (/\b(maybe|perhaps|not sure|what if|suppose|pretend|imagine)\b|\b(she|he|rose|my friend|the tv)\b/.test(c) && !/^tell rose\b/.test(c)) continue;
    const denied = /\b(no|not|never|don't|do not|haven't|have not|isn't|aren't|without)\b/.test(c);
    if (!denied && /\b(i|my|i've|i'm)\b.*\bcough(?:ing)?\b/.test(c)) findings.cough = true;
    if (!denied && (findings.cough || previous.cough || /cough/.test(c))) {
      const onset = c.match(/(?:since (?:yesterday|last [a-z]+)|(?:for |started |began )?(?:one|two|three|four|five|six|seven|\d+) days?(?: ago)?|started yesterday|began yesterday)/);
      if (onset) findings.cough_onset = onset[0];
    }
    if (!denied && (/cough/.test(c) || previous.cough) && /yesterday|since last|started|began|new|more often|worse|worsening|at night/.test(c)) findings.cough_change = true;
    if (/cough/.test(c) && /\b(no cough|not coughing|don't have (?:a |any )?cough)\b/.test(c)) findings.cough = false;
    if (!denied && /(?:pill|medicine|medication|lisinopril).*making me cough/.test(c)) { findings.cough = true; findings.medication_concern = true; }
    if (!denied && /(?:i think i(?:'ll| will)|i(?:'ll| will)|i(?:'m| am) (?:thinking|considering)).*(?:stop|skip).*(?:it|pill|medicine|medication|lisinopril)/.test(c)) findings.intends_to_stop_medication = true;
    // Sonic can finalize one resident utterance as multiple adjacent transcript blocks.
    // An unfinished intention is not affirmative until its explicit continuation arrives.
    if ((findings.medication_concern || previous.medication_concern) && /\bi (?:think i)?(?:'ll| will)$/.test(c)) findings.medication_intent_pending = true;
    if (previous.medication_intent_pending && /^(?:stop|skip) (?:taking )?(?:it|(?:my |the )?(?:pill|medicine|medication)|lisinopril)\b/.test(c)) {
      findings.intends_to_stop_medication = true; findings.medication_intent_pending = false;
    }
    if (!denied && /(?:my )?(?:lips?|tongue|throat).*(?:swelling|swollen|swell)|(?:swelling|swollen).*(?:my )?(?:lips?|tongue|throat)/.test(c)) { findings.emergency = true; findings.lip_tongue_swelling = true; }
    if (!denied && /(?:three|3|two|2|more|extra) pillows|(?:can't|cannot) (?:lie|lay) flat|breathless.*lying down/.test(c)) findings.extra_pillows = true;
    if (!denied && /(?:stop|stopped|pause|paused).*catch my breath|(?:breathless|short of breath).*(?:walk|breakfast|dining)|(?:walk|breakfast|dining).*catch my breath/.test(c)) findings.exertional_breathlessness = true;
    if (!denied && /(?:ankles?|legs?).*(?:puffy|swollen|swelling)|(?:swelling|swollen).*(?:ankles?|legs?)/.test(c)) findings.swelling = true;
    if (/\bno (?:ankle |leg )?swelling\b|(?:ankles?|legs?) (?:are |look )?not (?:swollen|puffy)/.test(c)) findings.swelling = false;
    if (!denied && /(?:skip|skipping|miss|missing).*bingo|too tired|more tired/.test(c)) findings.routine_change = true;
    if (/(?:i can't|i cannot|i can not) (?:catch my breath|breathe)(?:\b|$)|\bi(?:'m| am) (?:having )?severe (?:difficulty breathing|breathing difficulty)|\bi (?:have|am having) (?:severe )?chest pain\b/.test(c)) findings.emergency = true;
    if (/\b(no|not having|don't have|do not have) (?:any )?(?:breathing difficulty|difficulty breathing|chest pain)\b|breathing (?:fine|normally|comfortably)/.test(c)) findings.no_current_breathing_difficulty = true;
  }
  return findings;
}
export function remainingHeartFailurePlan(plan, findings = {}) {
  const answered = new Set();
  if (findings.cough !== undefined) answered.add('cough');
  if (findings.cough_onset) answered.add('onset');
  if (findings.extra_pillows !== undefined) answered.add('sleep');
  if (findings.exertional_breathlessness !== undefined) answered.add('activity');
  if (findings.swelling !== undefined) answered.add('swelling');
  if (findings.routine_change !== undefined) answered.add('routine');
  if (findings.medication_concern || findings.intends_to_stop_medication) answered.add('medication-concern');
  return { ...plan, answered_question_ids: [...answered], questions: plan.questions.filter(q => !answered.has(q.id)),
    instruction: plan.instruction + ' Questions already answered have been removed. Do not ask them again, including onset already recorded as since yesterday or four days ago. Stop the remaining questions if assessment or emergency help is needed.' };
}
export function heartFailureResponse(record, incident, receipt) {
  if (!incident || incident.route === 'clarify') return null;
  const delivered = receipt?.status === 'SIMULATED_DELIVERED';
  const delivery = delivered ? 'In this demo, the alert has been delivered to the simulated nurse inbox. No real notification or call was sent.' : 'The demo alert delivery is not confirmed. Please contact staff directly.';
  const name = record.preferred_name;
  const route = incident.route;
  const response = route === 'emergency'
    ? `${name}, call 911 now or ask someone nearby to call, and get facility staff immediately. ${delivered ? 'The facility emergency workflow has been activated in this demo only; no real emergency call was made.' : delivery} Do not wait for a routine nurse reply.`
    : route === 'prompt-assessment'
      ? `${name}, these changes from your usual routine need assessment by the nurse now. ${delivery} Rest in a comfortable seated position while seeking help.`
      : incident.findings?.medication_concern || incident.findings?.intends_to_stop_medication
        ? `That sounds frustrating, ${name}. A dry cough can happen with lisinopril, but we should not assume that is the cause. Please do not stop or change it on your own. Your nurse and prescriber should review it. ${delivery}`
        : `${name}, I have recorded the new cough you described for nurse review. ${delivery}`;
  const followUp = route !== 'clinical-review' ? null : record.id === 'robert' && !incident.findings?.no_current_breathing_difficulty
    ? 'Are you having any trouble breathing right now?'
    : !incident.findings?.cough_onset ? 'When did the cough begin?'
    : incident.findings?.extra_pillows === undefined ? 'Is the cough worse when you lie down?'
    : 'Has anything else changed?';
  return { priority: 'Say this safety and delivery message first. You may use natural wording but must include the demo-only disclosure and assessment urgency.', required_message: response,
    follow_up_question: followUp, follow_up_instruction: 'If routine questions are allowed, follow with one unanswered question. Use this suggestion only if it has not already been asked or answered in the conversation, including indirect or yes/no answers. Do not repeat it after an interruption.',
    routine_questions_allowed: route === 'clinical-review', forbidden_claims: ['A real nurse was contacted', 'A real emergency call was placed', 'A nurse is on the way', 'The cough cause is confirmed'] };
}
export function heartFailureRoute(findings, change) {
  if (findings.emergency) return 'emergency';
  if (findings.extra_pillows || findings.exertional_breathlessness || findings.swelling || change?.increase_lb > 3) return 'prompt-assessment';
  if (findings.cough || findings.cough_change || findings.medication_concern || findings.intends_to_stop_medication) return 'clinical-review';
  return 'clarify';
}
export function heartFailureGuidance(route) {
  if (route === 'emergency') return 'Demo emergency: stop routine questions and medication counseling. Say to call 911 now or ask someone nearby to call and activate the facility emergency workflow. The workflow here is simulated; no real emergency call has been placed. Do not wait for nurse acknowledgment or tool success to give this guidance. Do not tell someone with sudden lip/tongue swelling to continue a dose; medication decisions belong to the emergency clinician.';
  if (route === 'prompt-assessment') return 'These are changes from the documented baseline. Ask for nurse assessment now; do not wait for more symptoms or finish a questionnaire. Explain only changes actually reported or recorded. Once the tool confirms simulated delivery, say the demo alert was delivered and suggest resting in a comfortable seated position while seeking help. Do not imply real help is on its way.';
  return 'Report the new symptom to the assigned nurse under the demo care plan now. Briefly ask any unanswered onset, lying-down and other-change questions, one at a time. Do not minimize the concern or repeat answers already supplied.';
}
