// Browser text-to-speech (Web Speech API). Used for demo/fallback voice when Nova Sonic isn't connected.

let pending = 0;
let listener: ((speaking: boolean) => void) | null = null;

export const ttsSupported = () => typeof window !== "undefined" && "speechSynthesis" in window;

export function onSpeakingChange(fn: ((speaking: boolean) => void) | null) {
  listener = fn;
}

function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  const prefer = ["Samantha", "Google US English", "Microsoft Aria", "Microsoft Jenny", "Karen", "Moira", "Allison"];
  for (const name of prefer) {
    const v = voices.find((x) => x.name.includes(name));
    if (v) return v;
  }
  return voices.find((v) => v.lang === "en-US") ?? voices[0];
}

export function speak(text: string) {
  if (!ttsSupported() || !text.trim()) return;
  const u = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
  if (voice) u.voice = voice;
  u.rate = 0.95; // a touch slower for older listeners
  u.pitch = 1.05;
  const done = () => {
    pending = Math.max(0, pending - 1);
    if (pending === 0) listener?.(false);
  };
  u.onstart = () => listener?.(true);
  u.onend = done;
  u.onerror = done;
  pending++;
  window.speechSynthesis.speak(u);
}

export function cancelSpeech() {
  if (!ttsSupported()) return;
  pending = 0;
  window.speechSynthesis.cancel();
  listener?.(false);
}
