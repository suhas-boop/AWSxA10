import { useCallback, useEffect, useRef, useState } from "react";

// Browser speech-to-text (Web Speech API). In Chrome/Edge the audio is processed by the browser vendor's
// speech service, so it needs an internet connection. Safari uses on-device/Apple recognition.
/* eslint-disable @typescript-eslint/no-explicit-any */
const Ctor: any =
  typeof window !== "undefined" ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : undefined;

export function useBrowserListen(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<"blocked" | "network" | null>(null);
  const rec = useRef<any>(null);
  const cb = useRef(onFinal);
  cb.current = onFinal;

  const start = useCallback(() => {
    if (!Ctor || rec.current) return;
    const r = new Ctor();
    r.lang = "en-US";
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    r.onstart = () => {
      setListening(true);
      setError(null);
    };
    r.onresult = (e: any) => {
      let live = "";
      let done = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) done += res[0].transcript;
        else live += res[0].transcript;
      }
      setInterim(live);
      if (done.trim()) {
        setInterim("");
        cb.current(done.trim());
      }
    };
    r.onerror = (e: any) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") setError("blocked");
      else if (e.error === "network") setError("network");
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      setInterim("");
    };
    rec.current = r;
    try {
      r.start();
    } catch {
      rec.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    const r = rec.current;
    rec.current = null;
    if (r) {
      r.onend = null;
      try {
        r.abort();
      } catch {
        /* not running */
      }
    }
    setListening(false);
    setInterim("");
  }, []);

  useEffect(() => stop, [stop]);

  return { supported: !!Ctor, listening, interim, error, start, stop };
}
