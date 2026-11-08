import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckinProgress, findingsForAnswer } from '../server/care/checkin-progress.mjs';
import { dailyPlanContext } from '../server/care/daily-checkin.mjs';
import maggie from '../config/maggie-demo.json' with { type: 'json' };
const context = () => ({ daily_checkin: dailyPlanContext(maggie.profiles[0]), question_mode: 'daily_checkin' });
const reply = (p, question, text, id = 'turn') => {
  p.assistant({ id: `${id}-question`, text: question });
  return p.user({ id, text });
};
test('the supplied transcript short answers stay linked to the actual question', () => {
  const p = new CheckinProgress(); p.context(context(), []);
  assert.deepEqual(reply(p, 'Any need for an extra pillow?', 'yeah').findings, { extra_pillows: true });
  assert.deepEqual(reply(p, 'Did you need to stop for breath?', 'a little bit').findings, { exertional_breathlessness: true });
  assert.deepEqual(reply(p, 'Have your ankles looked more swollen than usual?', 'uh no').findings, { swelling: false });
  reply(p, 'Has staff checked your weight this morning?', 'no i think they are still yet to visit me');
  reply(p, 'How would you rate your energy for bingo?', 'good enough');
  reply(p, 'Has anything else changed, like breathing while resting or chest discomfort?', 'no no no');
  const result = p.context(context(), []);
  assert.deepEqual(result.daily_checkin.questions.map(q => q.id), ['cough']);
  assert.equal(result.conversation_state.covered_questions.weight.status, 'discussed');
  reply(p, 'Have you noticed any new cough?', 'no no no no cough');
  assert.equal(p.context(context(), []).conversation_state.phase, 'finished');
  for (const text of ['got it', 'okay', 'got it']) {
    p.user({ id: text, text });
    const next = p.context(context(), []);
    assert.deepEqual(next.daily_checkin.questions, []);
    assert.equal(next.question_mode, 'conversation');
    assert.equal(next.conversation_state.latest_is_acknowledgment, true);
  }
});
test('frustration or wanting to leave defers questions without inventing negatives', () => {
  for (const text of ['why are you asking the same thing over and over again', 'i wanna just go to bingo', 'stop asking questions']) {
    const p = new CheckinProgress(); p.context(context(), []);
    assert.equal(reply(p, 'Did you need more pillows?', text), null);
    const result = p.context(context(), []);
    assert.equal(result.conversation_state.phase, 'deferred_by_resident', text);
    assert.deepEqual(result.daily_checkin.questions, []);
    assert.deepEqual(result.conversation_state.covered_questions, {});
  }
});
test('uncertainty, ambiguous compound and reverse-polarity answers never become findings', () => {
  for (const [question, text] of [
    ['Did you need more pillows?', 'not sure'],
    ['Did you need more pillows?', 'not severe but a little bit uncomfortable'],
    ['Did you need more pillows or have swollen ankles?', 'yes'],
    ['You did not need more pillows, did you?', 'yes'],
    ['Did you walk comfortably to breakfast?', 'yes'],
  ]) {
    const p = new CheckinProgress(); p.context(context(), []);
    assert.deepEqual(reply(p, question, text)?.findings || {}, {}, question);
  }
  assert.deepEqual(findingsForAnswer('yeah', null), {});
});
test('split assistant questions on the same subject are tracked once; state survives history truncation', () => {
  const p = new CheckinProgress(); p.context(context(), []);
  p.assistant({ id: 'a', text: 'How was your breathing lying down?' });
  p.assistant({ id: 'b', text: 'Any need for extra pillows?' });
  const answer = p.user({ id: 'c', text: 'yeah' });
  assert.deepEqual(answer.question_ids, ['sleep']);
  assert.deepEqual(answer.assistant_turn_ids, ['a', 'b']);
  assert.deepEqual(answer.findings, { extra_pillows: true });
  assert.equal(p.context(context(), []).daily_checkin.questions.some(q => q.id === 'sleep'), false);
});
test('an acknowledgment of a previous answer is not part of the next question', () => {
  const p = new CheckinProgress(); p.context(context(), []);
  const answer = reply(p, 'Thanks, no cough. Did you need more pillows than usual?', 'yeah');
  assert.deepEqual(answer.question_ids, ['sleep']);
  assert.deepEqual(answer.findings, { extra_pillows: true });
  assert.equal(answer.question, 'Did you need more pillows than usual?');
});
test('a deferred check-in never suppresses a new safety contract', () => {
  const p = new CheckinProgress(); p.context(context(), []);
  p.user({ id: 'stop', text: 'stop asking questions' });
  const withAlert = () => ({ ...context(), incident: { id: 'incident', route: 'prompt-assessment', findings: { extra_pillows: true } }, question_mode: 'heart_failure_checkin',
    alert: { status: 'SIMULATED_DELIVERED' }, response_contract: { required_message: 'Nurse assessment now. Demo only.', routine_questions_allowed: false } });
  assert.equal(p.context(withAlert(), []).response_contract.message_already_delivered, false);
  p.assistant({ id: 'safety', text: 'The nurse should assess you now. The demo alert was delivered to a simulated inbox; no real notification was sent.' });
  p.user({ id: 'thanks', text: 'got it' });
  assert.equal(p.context(withAlert(), []).response_contract.message_already_delivered, true);
  const emergency = withAlert(); emergency.incident.route = 'emergency';
  assert.equal(p.context(emergency, []).response_contract.message_already_delivered, false);
  assert.equal(emergency.question_mode, 'heart_failure_checkin');
});
