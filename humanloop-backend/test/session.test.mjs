import test from 'node:test';
import assert from 'node:assert/strict';
import { SonicSession } from '../server/session.mjs';
import { ToolRunner } from '../server/tool-runner.mjs';
import { fakeTransport, principal, testTool, until } from './helpers.mjs';

function setup(t, tool = testTool()) {
  const events = [], transport = fakeTransport();
  const runner = new ToolRunner({ tools: [tool], principal: principal(), authorize: async () => true, emit: value => events.push(value) });
  const session = new SonicSession({ transport, runner, emit: value => events.push(value) });
  t.after(() => session.stop());
  return { events, transport, runner, session };
}
test('protocol initializes system and audio in order with correct PCM rates', async t => {
  const { session, transport } = setup(t); await session.start();
  session.audio(new Uint8Array(1024));
  await until(() => transport.connections[0].input.some(x => x.event.audioInput));
  const input = transport.connections[0].input;
  assert.equal(Object.keys(input[0].event)[0], 'sessionStart');
  assert.equal(input[1].event.promptStart.audioOutputConfiguration.sampleRateHertz, 24000);
  const audio = input.find(x => x.event.contentStart?.type === 'AUDIO').event.contentStart;
  assert.equal(audio.audioInputConfiguration.sampleRateHertz, 16000);
  assert.equal(input.at(-1).event.audioInput.contentName, audio.contentName);
  assert.throws(() => session.audio(new Uint8Array(3)), /Invalid PCM/);
});
test('interruption clears old audio without muting later content in the same completion', async t => {
  const { session, transport, events } = setup(t); await session.start();
  const out = transport.connections[0].output;
  out.push({ audioOutput: { completionId: 'shared-completion', contentId: 'audio-1', content: 'AAAA' } });
  out.push({ textOutput: { completionId: 'shared-completion', contentId: 'notice-1', content: '{"interrupted":true}' } });
  out.push({ contentEnd: { completionId: 'shared-completion', contentId: 'audio-1', stopReason: 'INTERRUPTED' } });
  out.push({ audioOutput: { completionId: 'shared-completion', contentId: 'audio-1', content: 'BBBB' } });
  out.push({ audioOutput: { completionId: 'shared-completion', contentId: 'audio-2', content: 'CCCC' } });
  await until(() => events.filter(x => x.type === 'audio').length === 2);
  assert.deepEqual(events.filter(x => x.type === 'audio').map(x => x.data), ['AAAA', 'CCCC']);
  assert.equal(events.filter(x => x.type === 'interrupt').length, 1);
  // The next interruption must work too, despite the reused completion ID.
  out.push({ textOutput: { completionId: 'shared-completion', contentId: 'notice-2', content: '{"interrupted":true}' } });
  out.push({ audioOutput: { completionId: 'shared-completion', contentId: 'audio-2', content: 'DDDD' } });
  out.push({ audioOutput: { completionId: 'shared-completion', contentId: 'audio-3', content: 'EEEE' } });
  await until(() => events.filter(x => x.type === 'audio').length === 3);
  assert.deepEqual(events.filter(x => x.type === 'audio').map(x => x.data), ['AAAA', 'CCCC', 'EEEE']);
  assert.equal(events.filter(x => x.type === 'interrupt').length, 2);
});

test('an interrupted open audio block cannot leak its first delayed chunk into playback', async t => {
  const { session, transport, events } = setup(t); await session.start();
  const out = transport.connections[0].output;
  out.push({ contentStart: { contentId: 'old-open-audio', role: 'ASSISTANT', type: 'AUDIO' } });
  out.push({ textOutput: { completionId: 'shared', contentId: 'notice', content: '{"interrupted":true}' } });
  out.push({ audioOutput: { completionId: 'shared', contentId: 'old-open-audio', content: 'AAAA' } });
  out.push({ audioOutput: { completionId: 'shared', contentId: 'new-audio', content: 'BBBB' } });
  // A delayed duplicate end for the old block must not clear new playback.
  out.push({ contentEnd: { contentId: 'old-open-audio', stopReason: 'INTERRUPTED' } });
  await until(() => events.some(e => e.type === 'audio'));
  assert.deepEqual(events.filter(e => e.type === 'audio').map(e => e.data), ['BBBB']);
  assert.equal(events.filter(e => e.type === 'interrupt').length, 1);
});
test('only final assistant text is retained and renewal replays history before audio', async t => {
  const { session, transport, events } = setup(t); await session.start();
  const out = transport.connections[0].output;
  for (const [id, stage, text] of [['preview', 'SPECULATIVE', 'Unspoken text'], ['final', 'FINAL', 'Actually spoken']]) {
    out.push({ contentStart: { contentId: id, type: 'TEXT', role: 'ASSISTANT', additionalModelFields: JSON.stringify({ generationStage: stage }) } });
    out.push({ textOutput: { contentId: id, content: text } });
    out.push({ contentEnd: { contentId: id } });
  }
  await until(() => session.history.length === 1);
  assert.equal(session.history[0].text, 'Actually spoken');
  assert.equal(events.some(x => x.text === 'Unspoken text'), false);
  await session.renew();
  await until(() => transport.connections[1].input.some(x => x.event.contentStart?.type === 'AUDIO'));
  const input = transport.connections[1].input;
  const historyIndex = input.findIndex(x => x.event.textInput?.content === 'Actually spoken');
  assert.ok(historyIndex > 0);
  assert.ok(historyIndex < input.findIndex(x => x.event.contentStart?.type === 'AUDIO'));
  assert.notEqual(transport.connections[0].input[1].event.promptStart.promptName, input[1].event.promptStart.promptName);
});
test('slow tools do not block audio and return wrapped results', async t => {
  let resolveTool;
  const { session, transport, events } = setup(t, testTool({ execute: () => new Promise(resolve => { resolveTool = resolve; }) }));
  await session.start();
  const c = transport.connections[0];
  c.output.push({ toolUse: { toolUseId: 'tool-1', toolName: 'test_tool', content: '{}' } });
  c.output.push({ audioOutput: { completionId: 'continuation', contentId: 'audio-continuation', content: 'AAAA' } });
  await until(() => resolveTool && events.some(x => x.type === 'audio'));
  resolveTool({ answer: 42 });
  await until(() => c.input.some(x => x.event.toolResult));
  const resultIndex = c.input.findIndex(x => x.event.toolResult);
  assert.equal(c.input[resultIndex - 1].event.contentStart.toolResultInputConfiguration.toolUseId, 'tool-1');
  assert.equal(JSON.parse(c.input[resultIndex].event.toolResult.content).result.answer, 42);
  assert.ok(c.input[resultIndex + 1].event.contentEnd);
});
test('ending a session delivers cancellation results before closing the stream', async t => {
  const { session, transport } = setup(t, testTool({ execute: () => new Promise(() => {}) }));
  await session.start(); const c = transport.connections[0];
  c.output.push({ toolUse: { toolUseId: 'pending', toolName: 'test_tool', content: '{}' } });
  await until(() => session.runner.controllers.size === 1);
  await session.stop();
  const resultIndex = c.input.findIndex(x => x.event.toolResult);
  const endIndex = c.input.findIndex(x => x.event.sessionEnd);
  assert.ok(resultIndex > 0 && resultIndex < endIndex);
  assert.equal(JSON.parse(c.input[resultIndex].event.toolResult.content).ok, false);
  assert.deepEqual(c.input.slice(-3).map(x => Object.keys(x.event)[0]), ['contentEnd', 'promptEnd', 'sessionEnd']);
});
test('failed Bedrock startup ends the session with an actionable error', async () => {
  const events = [];
  const session = new SonicSession({ transport: { open: async () => { const error = new Error(); error.name = 'AccessDeniedException'; throw error; } }, runner: { specs: () => [], cancel() {} }, emit: e => events.push(e) });
  await session.start();
  assert.equal(session.active, false);
  assert.match(events.find(x => x.type === 'error').message, /denied access/);
  assert.equal(events.at(-1).status, 'ended');
});
test('automatic renewal waits for an active model turn to finish', async t => {
  const { session, transport } = setup(t);
  session.renewAfterMs = 20; session.hardRenewMs = 1000;
  await session.start();
  transport.connections[0].output.push({ completionStart: { completionId: 'active-turn' } });
  await until(() => session.connection.renewRequested);
  assert.equal(transport.connections.length, 1);
  transport.connections[0].output.push({ completionEnd: { completionId: 'active-turn', stopReason: 'END_TURN' } });
  await until(() => transport.connections.length === 2);
  assert.ok(session.history.length === 0);
});
test('model-first greeting waits for capture, runs once and is not saved as resident speech', async t => {
  const { session, transport, events } = setup(t);
  const reported = []; session.initialPrompt = 'Application event: start the daily conversation.'; session.onFinalTurn = turn => reported.push(turn);
  await session.start();
  assert.equal(transport.connections[0].input.some(x => x.event.textInput?.content === session.initialPrompt), false);
  session.audio(new Uint8Array(1024)); session.audio(new Uint8Array(1024));
  await until(() => transport.connections[0].input.some(x => x.event.textInput?.content === session.initialPrompt));
  const first = transport.connections[0].input;
  const index = first.findIndex(x => x.event.textInput?.content === session.initialPrompt);
  assert.equal(first[index - 1].event.contentStart.interactive, true);
  assert.equal(first.filter(x => x.event.textInput?.content === session.initialPrompt).length, 1);
  const output = transport.connections[0].output;
  output.push({ contentStart: { contentId: 'echo', role: 'USER', type: 'TEXT' } });
  output.push({ textOutput: { contentId: 'echo', content: session.initialPrompt } });
  output.push({ contentEnd: { contentId: 'echo' } });
  await until(() => session.connection.modelEvents >= 3);
  await session.renew(); session.audio(new Uint8Array(1024));
  await until(() => transport.connections[1].input.some(x => x.event.audioInput));
  assert.equal(transport.connections[1].input.some(x => x.event.textInput?.content === session.initialPrompt), false);
  assert.deepEqual(reported, []); assert.equal(events.some(e => e.type === 'transcript' && e.role === 'USER'), false);
});
test('renewal can replay an assistant-first greeting without fabricating resident history', async t => {
  const { session, transport } = setup(t); await session.start();
  session.history = [{ role: 'ASSISTANT', text: 'Hello.' }, { role: 'ASSISTANT', text: 'How was your day?' }, { role: 'USER', text: 'I enjoyed gardening.' }];
  await session.renew();
  await until(() => transport.connections[1].input.some(x => x.event.contentStart?.type === 'AUDIO'));
  const starts = transport.connections[1].input.filter(x => x.event.contentStart?.type === 'TEXT').map(x => x.event.contentStart.role);
  assert.deepEqual(starts, ['SYSTEM', 'USER', 'ASSISTANT', 'USER']);
  assert.ok(transport.connections[1].input.some(x => x.event.textInput?.content === 'Hello.\nHow was your day?'));
  assert.equal(session.history.length, 3); assert.equal(session.history.filter(x => x.role === 'USER').length, 1);
});
test('staff application update is interactive, waits for idle, and never becomes resident speech', async t => {
  const { session, transport, events } = setup(t), reported = [];
  session.onFinalTurn = turn => reported.push(turn); await session.start();
  const text = 'Application event: staff update for request 123.';
  session.connection.busy = true; assert.equal(session.notify(text), false);
  session.connection.busy = false; assert.equal(session.notify(text), true);
  await until(() => transport.connections[0].input.some(x => x.event.textInput?.content === text));
  const output = transport.connections[0].output;
  output.push({ contentStart: { contentId: 'staff-event', role: 'USER', type: 'TEXT' } });
  output.push({ textOutput: { contentId: 'staff-event', content: text } });
  output.push({ contentEnd: { contentId: 'staff-event' } });
  await until(() => session.connection.modelEvents >= 3);
  assert.deepEqual(reported, []); assert.equal(session.history.length, 0);
  assert.equal(events.some(e => e.type === 'transcript' && e.role === 'USER'), false);
});
test('Nova completion can span turns; quiet finalized speech permits a staff update without completionEnd', async t => {
  const { session, transport } = setup(t); await session.start(); const output = transport.connections[0].output;
  output.push({ completionStart: { completionId: 'long-lived' } });
  output.push({ contentStart: { contentId: 'answer', role: 'ASSISTANT', type: 'TEXT', additionalModelFields: JSON.stringify({ generationStage: 'FINAL' }) } });
  output.push({ textOutput: { contentId: 'answer', content: 'Your request is in the inbox.' } });
  output.push({ contentEnd: { contentId: 'answer', stopReason: 'END_TURN' } });
  await until(() => session.history.length === 1);
  assert.equal(session.connection.busy, true); assert.equal(session.canNotify(), false);
  session.connection.lastOutputAt = Date.now() - 2000;
  assert.equal(session.notify('Application event: a saved reply is available.'), true);
  assert.equal(session.canNotify(), false, 'do not enqueue another update before this one is answered');
});
