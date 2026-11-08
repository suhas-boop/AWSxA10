// Bounded question tracking for the supplied demo plans. This is not a clinical
// classifier. Only finalized, actually spoken questions can contextualize a reply.
const topics = {
  cough: /\bcough\b/i,
  onset: /\b(?:when|how long)\b.*\bcough\b|\bcough\b.*\b(?:start|began|begin)\b/i,
  sleep: /\bpillows?\b|\b(?:lie|lay|lying) (?:down|flat)\b/i,
  activity: /\bwalk\b.*\b(?:dining|breakfast|breath|usual)\b|\b(?:stop|pause)\b.*\bbreath\b/i,
  swelling: /\b(?:ankles?|legs?)\b.*\b(?:swollen|swelling|puffy)\b|\b(?:swollen|swelling|puffy)\b.*\b(?:ankles?|legs?)\b/i,
  weight: /\bweight\b/i,
  routine: /\benergy\b|\btoo tired\b/i,
  other: /\banything else\b|\b(?:resting|chest discomfort|chest pain)\b/i,
  'medication-concern': /\b(?:medication|medicine|dose|lisinopril)\b/i,
};

export function questionTopics(text, allowed) {
  if (!text.includes('?')) return [];
  const questions = (text.match(/[^.!?]+\?/g) || []).join(' ');
  const ids = Object.entries(topics).filter(([id, pattern]) => allowed.has(id) && pattern.test(questions)).map(([id]) => id);
  return ids.includes('onset') ? ids.filter(id => id !== 'cough') : ids;
}

// Preserve a short answer as a quote plus its real question, never rewrite it
// into a fabricated resident statement. Ambiguous and compound questions cannot
// create findings; explicit self-contained symptom reports use the existing path.
export function findingsForAnswer(text, answer) {
  if (!answer || answer.question_ids?.length !== 1 || typeof answer.question !== 'string') return {};
  const s = text.toLowerCase().replaceAll('’', "'").replace(/[.!?,]/g, '').trim().replace(/^(?:uh|um)\s+/, '');
  const positive = /^(?:yes|yeah|yep|a little bit|a little|a bit|just a little)(?: (?:a little bit|a little))?$/.test(s);
  const negative = /^(?:no(?: no)*|nope|not at all)$/.test(s);
  if (!positive && !negative) return {};
  const id = answer.question_ids[0], q = answer.question.toLowerCase();
  const field = id === 'sleep' && /(?:extra|more|additional) pillows?/.test(q) ? 'extra_pillows'
    : id === 'activity' && /(?:stop|pause).*breath|(?:breathless|short of breath)/.test(q) ? 'exertional_breathlessness'
    : id === 'swelling' && /swollen|swelling|puffy/.test(q) ? 'swelling'
    : id === 'cough' && /(?:noticed|have|having).*cough/.test(q) ? 'cough' : null;
  // A negatively framed question reverses yes/no meaning; leave it unresolved.
  if (!field || /\b(?:not|no|without|haven't|don't|isn't|aren't)\b/.test(q)) return {};
  return { [field]: positive };
}

export class CheckinProgress {
  constructor() {
    this.allowed = new Set(); this.covered = new Map(); this.pending = [];
    this.deferred = false; this.lastUser = ''; this.responseKey = null; this.deliveredKey = null;
    this.responseText = '';
  }
  assistant(turn) {
    const questions = (turn.text.match(/[^.!?]+\?/g) || []).join(' ').trim();
    const ids = questionTopics(questions, this.allowed);
    if (ids.length) this.pending.push({ ids, text: questions, id: turn.id });
    this.responseText += ' ' + turn.text;
    // Only mark the safety contract delivered after actual final speech contains
    // both the urgency and the simulation disclosure. Never suppress a new route.
    const s = this.responseText;
    const disclosed = /demo|simulat/i.test(s) && /(?:no real|not.*real)/i.test(s);
    const urgency = this.route === 'emergency' ? /911|nine.one.one/i.test(s)
      : this.route === 'prompt-assessment' ? /nurse|assess/i.test(s) && /now/i.test(s) : /nurse|review/i.test(s);
    if (this.responseKey && disclosed && urgency) this.deliveredKey = this.responseKey;
  }
  user(turn) {
    this.lastUser = turn.text;
    const stop = /stop (?:asking|the questions|the check.?in)|same (?:thing|question)|over and over|already (?:answered|told)|(?:i |we )(?:just )?(?:want|wanna) (?:just )?(?:to )?(?:go|stop)|no more questions|(?:i'm|i am|we're|we are) done/i.test(turn.text);
    if (stop) this.deferred = true;
    const pending = this.pending;
    this.pending = []; this.responseText = '';
    if (!pending.length || stop) return null;
    const ids = [...new Set(pending.flatMap(p => p.ids))];
    const question = pending.map(p => p.text).join(' ').slice(-2000);
    const answer = { question_ids: ids, question, assistant_turn_ids: pending.map(p => p.id) };
    const findings = findingsForAnswer(turn.text, answer);
    const uncertain = /not sure|don't know|do not know|maybe|perhaps|what do you mean/i.test(turn.text);
    const acknowledgment = /^(?:okay|ok|got it|thanks|thank you|cool)[.! ]*$/i.test(turn.text.trim());
    // Off-topic replies do not become clinical negatives. Do not chase an answer
    // when the resident has moved on; expose unresolved items explicitly.
    for (const id of ids) this.covered.set(id, {
      status: uncertain || acknowledgment || ids.length !== 1 ? 'unresolved' : 'discussed',
      answer_turn_id: turn.id,
    });
    return { ...answer, findings };
  }
  context(result, history) {
    if (!result.daily_checkin?.configured) return result;
    const plan = result.daily_checkin;
    for (const q of plan.questions) this.allowed.add(q.id);
    const answered = new Set(plan.answered_question_ids || []);
    for (const id of answered) this.covered.set(id, { status: 'answered' });
    const questions = plan.questions.filter(q => !this.covered.has(q.id) && (q.id !== 'onset' || result.incident?.findings?.cough === true));
    const terminal = this.deferred || !questions.length;
    const safety = result.response_contract;
    if (safety) {
      const key = JSON.stringify([result.incident?.id, result.incident?.route, result.incident?.findings, result.alert?.status]);
      if (key !== this.responseKey) this.responseText = '';
      this.responseKey = key; this.route = result.incident?.route;
      safety.message_already_delivered = key === this.deliveredKey;
      if (terminal || safety.routine_questions_allowed === false) safety.follow_up_question = null;
    }
    const social = /\b(?:rose|rosie)\b.*\bbingo\b|\b(?:go|going) to bingo\b/i.test(this.lastUser);
    result.conversation_state = {
      phase: this.deferred ? 'deferred_by_resident' : !questions.length ? 'finished' : 'in_progress',
      covered_questions: Object.fromEntries(this.covered),
      latest_is_acknowledgment: /^(?:okay|ok|got it|thanks|thank you|cool)[.! ]*$/i.test(this.lastUser.trim()),
      instruction: terminal
        ? 'Stop the routine checklist for this session. Do not restart it, add one last question, or treat missing answers as normal findings. Respond to the resident\'s actual topic. For a closing acknowledgment, give at most a brief acknowledgment, with no repeated summary, handoff promise or question. New safety concerns still take priority.'
        : 'Only the remaining questions may be asked. Covered items must not be rephrased or asked again. Unresolved items are unknown, never negative findings.',
    };
    result.daily_checkin = { ...plan, questions: terminal ? [] : questions, phase: terminal ? result.conversation_state.phase : history.filter(t => t.role === 'USER').length < 2 ? 'casual_opening' : 'checkin_questions' };
    if ((terminal || social) && ['daily_checkin', 'conversation'].includes(result.question_mode)) {
      result.question_mode = 'conversation'; result.next_question = null;
    }
    if (social) result.conversation_state.instruction += ' Answer the bingo question first. This clinical session cannot check shared attendance; say that limitation briefly and direct the resident to the everyday companion view. Do not immediately pivot to a clinical question unless a new safety concern requires it.';
    return result;
  }
}
