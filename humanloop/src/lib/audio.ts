// Mic capture at 16 kHz PCM16 and playback of 24 kHz PCM16 (what Nova Sonic expects / returns).

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;

  async start(onChunk: (pcm: ArrayBuffer) => void, onLevel: (level: number) => void) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext({ sampleRate: 16000 });
    if (this.ctx.sampleRate !== 16000) {
      throw new Error("This browser can't capture 16 kHz audio. Try Chrome, Edge or Safari.");
    }
    await this.ctx.audioWorklet.addModule("/pcm-capture.js");
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm-capture");
    this.node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      onChunk(e.data.pcm);
      onLevel(e.data.level);
    };
    source.connect(this.node);
  }

  stop() {
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }
}

export class PCMPlayer {
  private ctx = new AudioContext({ sampleRate: 24000 });
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();

  resume() {
    return this.ctx.resume();
  }

  enqueueBase64(b64: string) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
    const floats = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 0x8000;
    const buffer = this.ctx.createBuffer(1, floats.length, 24000);
    buffer.copyToChannel(floats, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime + 0.02, this.nextTime);
    src.start(startAt);
    this.nextTime = startAt + buffer.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  /** Stop everything queued (used when the user interrupts the assistant). */
  flush() {
    this.sources.forEach((s) => {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    });
    this.sources.clear();
    this.nextTime = 0;
  }

  close() {
    this.flush();
    void this.ctx.close();
  }
}

/** Downscale a photo before upload so requests stay small. */
export function resizeImage(file: File, maxSide = 1024): Promise<{ blob: Blob; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => (blob ? resolve({ blob, dataUrl: canvas.toDataURL("image/jpeg", 0.8) }) : reject(new Error("Could not read photo"))),
        "image/jpeg",
        0.8,
      );
    };
    img.onerror = () => reject(new Error("Could not read photo"));
    img.src = url;
  });
}
