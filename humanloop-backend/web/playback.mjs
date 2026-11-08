export class PcmPlayback {
  constructor(context, onPlayback) { this.context = context; this.onPlayback = onPlayback; this.sources = new Set(); this.nextTime = context.currentTime; }
  play(base64) {
    if (this.context.state !== 'running') return;
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    if (!bytes.length || bytes.length % 2) throw new Error('Invalid playback audio');
    const pcm = new DataView(bytes.buffer);
    const buffer = this.context.createBuffer(1, bytes.length / 2, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) channel[i] = pcm.getInt16(i * 2, true) / 32768;
    if (this.nextTime - this.context.currentTime > 30) throw new Error('Playback fell behind. Please reconnect.');
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    this.sources.add(source);
    source.onended = () => { source.disconnect(); this.sources.delete(source); if (!this.sources.size) this.onPlayback(false); };
    this.nextTime = Math.max(this.nextTime, this.context.currentTime + 0.015);
    source.start(this.nextTime); this.nextTime += buffer.duration; this.onPlayback(true);
  }
  clear() {
    for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear(); this.nextTime = this.context.currentTime; this.onPlayback(false);
  }
}
