import Ajv from 'ajv';
const text = { type: 'string', minLength: 1, maxLength: 1000 };
const validate = new Ajv({ strict: true }).compile({
  type: 'object', additionalProperties: false, required: ['version', 'enabled', 'questions'],
  properties: {
    version: { type: 'string', minLength: 1, maxLength: 100 }, enabled: { type: 'boolean' },
    opening: { type: 'string', maxLength: 500 },
    questions: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['id', 'condition', 'question', 'required'], properties: {
      id: { type: 'string', minLength: 1, maxLength: 100 }, condition: text, question: text, required: { type: 'boolean' },
    } } },
  },
});
export function validateDailyPlan(plan) {
  if (!validate(plan)) throw new Error('Invalid daily check-in plan. Supply a version, enabled flag, and questions with id, condition, question and required.');
  if (new Set(plan.questions.map(q => q.id)).size !== plan.questions.length) throw new Error('Question IDs must be unique.');
  if (plan.enabled && !plan.questions.length) throw new Error('An enabled plan needs at least one supplied question.');
  return plan;
}
export function dailyPlanContext(record) {
  if (!record?.daily_checkin?.enabled) return { configured: false, questions: [], instruction: 'No disease-specific daily question plan has been supplied. Have a friendly conversation; do not invent mandatory disease questions.' };
  try { validateDailyPlan(record.daily_checkin); } catch { return { configured: false, questions: [], instruction: 'The daily plan is unavailable. Do not invent its questions or claim a completed check-in.' }; }
  return { configured: true, version: record.daily_checkin.version, opening: record.daily_checkin.opening || null, questions: record.daily_checkin.questions,
    instruction: 'Start with a casual exchange. Then gently weave these supplied questions into the conversation, one at a time. Use the conversation to recognize answers in the resident\'s own words, including indirect answers; do not repeat a question already answered. Clarify uncertainty once, and accept declining to answer. Do not invent medical criteria, diagnoses, thresholds, or claim that sharing or clinical review occurred.' };
}
export function pacedDailyPlan(plan, history) {
  if (!plan?.configured) return plan;
  const turns = history.filter(t => t.role === 'USER').length;
  return { ...plan, phase: turns < 2 ? 'casual_opening' : 'checkin_questions', resident_turns: turns,
    pacing: turns < 2 ? 'Stay with a warm, casual conversation for now. Do not launch the condition-specific questions yet unless the resident asks to begin them. An explicit urgent concern takes priority.' : 'Acknowledge what the resident said, then naturally transition to one unanswered supplied question. If answers already cover it, move on. Avoid a questionnaire monologue.' };
}
