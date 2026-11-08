import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, breathingAnswer, explicitEmergency, questionFor, yesNo } from '../server/care/rules.mjs';
test('explicit personal danger is not suppressed by an unrelated TV or negative clause', () => {
  assert.equal(explicitEmergency('I cannot breathe. I was watching TV.'), true);
  assert.equal(explicitEmergency('I do not have chest pain, but I cannot breathe.'), true);
  assert.equal(explicitEmergency('I do not have chest pain.'), false);
  assert.equal(explicitEmergency('What if I cannot breathe?'), false);
  assert.equal(explicitEmergency('The TV said I cannot breathe.'), false);
});
test('uncertain or contradictory answers need clarification', () => {
  for (const phrase of ['Yes, no, actually I do not know.', 'Yes, but I am not sure.', 'Maybe.']) assert.equal(yesNo(phrase), null);
  assert.equal(yesNo('No, that was the TV.'), false);
});
test('natural denial of severe breathing difficulty advances without denying discomfort', () => {
  for (const phrase of ['not severe but a little bit uncomfortable', "It's not severe, but a little uncomfortable.", "I'm breathing fine.", 'I can breathe normally.', 'I do not have severe difficulty breathing.']) {
    const result = advance({ phase: 'breathing', topic: 'cough', clarification_attempts: 1 }, phrase);
    assert.equal(result.phase, 'ready', phrase);
    assert.equal(result.severe_breathing, false);
    assert.equal(result.route, 'clinical-review');
    assert.equal(result.clarification_attempts, 0);
  }
  assert.equal(advance({ phase: 'source' }, 'not severe but a little bit uncomfortable').phase, 'source');
});
test('ambiguous, incomplete, hypothetical and third-party breathing statements stay unconfirmed', () => {
  for (const phrase of ['not severe but', 'a little uncomfortable', "I'm not sure it is severe", "What if I'm breathing fine?", 'She is breathing fine.', "I'm breathing fine but it is severe.", 'It was not severe yesterday.', 'not severe but I am unsure']) {
    assert.equal(breathingAnswer(phrase), null, phrase);
    assert.equal(advance({ phase: 'breathing' }, phrase).phase, 'breathing');
  }
  assert.equal(advance({ phase: 'breathing' }, 'Not severe but I cannot breathe.').phase, 'emergency');
});
test('unrecognized replies offer controls instead of indefinitely repeating the same question', () => {
  let incident = { phase: 'breathing' };
  incident = advance(incident, 'I do not know how to explain it');
  assert.match(questionFor(incident), /could not tell/);
  incident = advance(incident, 'Why are you repeating yourself');
  assert.equal(incident.phase, 'breathing');
  assert.match(questionFor(incident), /buttons/);
  assert.doesNotMatch(questionFor(incident), /Are you having/);
  assert.equal(advance(incident, 'No.').phase, 'ready');
});
