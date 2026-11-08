import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmPlayback } from '../web/playback.mjs';
test('interruption stops every scheduled source and resets the next playback time', () => {
  const sources = [], changes = [];
  const context = {
    currentTime: 3, state: 'running', destination: {},
    createBuffer(_channels, length, rate) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; },
    createBufferSource() { const source = { connect() {}, disconnect() { this.disconnected = true; }, start(time) { this.at = time; }, stop() { this.stopped = true; } }; sources.push(source); return source; },
  };
  const playback = new PcmPlayback(context, value => changes.push(value));
  const chunk = Buffer.alloc(48000).toString('base64');
  playback.play(chunk); playback.play(chunk); playback.play(chunk);
  assert.ok(sources[2].at > 5);
  playback.clear();
  assert.ok(sources.every(source => source.stopped && source.disconnected));
  assert.equal(playback.sources.size, 0);
  assert.equal(changes.at(-1), false);
  context.currentTime = 3.5;
  playback.play(chunk);
  assert.equal(sources[3].at, 3.515);
});
test('playback decodes signed little-endian 24 kHz audio', () => {
  let decoded, sampleRate;
  const context = { state: 'running', currentTime: 0, destination: {},
    createBuffer(_channels, length, rate) { decoded = new Float32Array(length); sampleRate = rate; return { duration: length / rate, getChannelData: () => decoded }; },
    createBufferSource: () => ({ connect() {}, start() {} }),
  };
  const playback = new PcmPlayback(context, () => {});
  playback.play(Buffer.from([0, 128, 0, 64]).toString('base64'));
  assert.equal(sampleRate, 24000); assert.deepEqual([...decoded], [-1, 0.5]);
  assert.throws(() => playback.play('AA=='), /Invalid playback/);
});
