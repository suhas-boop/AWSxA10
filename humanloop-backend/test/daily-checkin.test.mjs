import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyPlanContext, pacedDailyPlan, validateDailyPlan } from '../server/care/daily-checkin.mjs';
const plan = { version: 'test-only-v1', enabled: true, questions: [{ id: 'experience', condition: 'synthetic condition', question: 'How has this affected your day?', required: true }] };
test('unpopulated or malformed patient plans never invent disease questions', () => {
  for (const record of [null, {}, { daily_checkin: { enabled: false } }, { daily_checkin: { enabled: true, questions: [] } }]) assert.equal(dailyPlanContext(record).configured, false);
});
test('configured daily questions remain scoped to the selected profile and are paced after casual turns', () => {
  const context = dailyPlanContext({ daily_checkin: plan });
  assert.deepEqual(context.questions, plan.questions);
  assert.equal(pacedDailyPlan(context, []).phase, 'casual_opening');
  assert.equal(pacedDailyPlan(context, [{ role: 'USER' }, { role: 'ASSISTANT' }]).phase, 'casual_opening');
  assert.equal(pacedDailyPlan(context, [{ role: 'USER' }, { role: 'ASSISTANT' }, { role: 'USER' }]).phase, 'checkin_questions');
  assert.equal(dailyPlanContext({}).questions.length, 0);
});
test('daily plan validation rejects duplicate IDs, empty enabled plans and unexpected fields', () => {
  assert.throws(() => validateDailyPlan({ ...plan, questions: [...plan.questions, ...plan.questions] }), /unique/);
  assert.throws(() => validateDailyPlan({ ...plan, questions: [] }), /at least one/);
  assert.throws(() => validateDailyPlan({ ...plan, bypassConsent: true }), /Invalid/);
});
