import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmResampler } from '../web/pcm.mjs';
for (const rate of [16000, 44100, 48000]) test(`${rate} Hz capture produces 16 kHz PCM without block-boundary drift`, () => {
  const resampler = new PcmResampler(rate, 16000, 160);
  const frames = [];
  const input = new Float32Array(rate).fill(0.5);
  for (let i = 0; i < input.length; i += 128) resampler.push(input.subarray(i, i + 128), frame => frames.push(frame));
  assert.equal(frames.length, 100);
  assert.equal(new DataView(frames[0]).getInt16(0, true), 16384);
});
test('mute maintains the stream using silence', () => {
  const resampler = new PcmResampler(48000, 16000, 160);
  const frames = [];
  resampler.push(new Float32Array(480).fill(1), frame => frames.push(frame), true);
  assert.equal(frames.length, 1);
  assert.ok(new Uint8Array(frames[0]).every(x => x === 0));
});
