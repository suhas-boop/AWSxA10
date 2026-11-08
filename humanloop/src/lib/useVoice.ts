import { useCallback, useEffect, useRef, useState } from "react";
import { MicCapture, PCMPlayer } from "./audio";
import type { NurseAlert } from "../types";

export type VoiceStatus = "idle" | "connecting" | "live" | "unavailable" | "error";

type Handlers = {
  onTranscript: (role: "user" | "assistant", text: string) => void;
  onAlert: (alert: NurseAlert) => void;
  onCheckIn: () => void;
};

export function useVoice(handlers: Handlers) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [level, setLevel] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [mock, setMock] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const ws = useRef<WebSocket | null>(null);
  const mic = useRef<MicCapture | null>(null);
  const player = useRef<PCMPlayer | null>(null);
  const speakTimer = useRef<number>(0);
  const h = useRef(handlers);
  h.current = handlers;

  const cleanup = useCallback(() => {
    mic.current?.stop();
    mic.current = null;
    player.current?.close();
    player.current = null;
    if (ws.current && ws.current.readyState <= 1) ws.current.close();
    ws.current = null;
    setLevel(0);
    setSpeaking(false);
  }, []);

  const stop = useCallback(() => {
    if (ws.current?.readyState === 1) ws.current.send(JSON.stringify({ type: "stop" }));
    cleanup();
    setStatus("idle");
  }, [cleanup]);

  const start = useCallback(async () => {
    setMessage(null);
    setStatus("connecting");
    try {
      player.current = new PCMPlayer();
      await player.current.resume();

      const proto = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${proto}://${location.host}/voice`);
      socket.binaryType = "arraybuffer";
      ws.current = socket;

      await new Promise<void>((resolve, reject) => {
        const t = window.setTimeout(() => reject(new Error("unreachable")), 4000);
        socket.onopen = () => {
          window.clearTimeout(t);
          resolve();
        };
        socket.onerror = () => {
          window.clearTimeout(t);
          reject(new Error("unreachable"));
        };
      });

      socket.onmessage = (e) => {
        if (typeof e.data !== "string") return;
        const m = JSON.parse(e.data);
        switch (m.type) {
          case "ready":
            setMock(!!m.mock);
            setStatus("live");
            break;
          case "transcript":
            h.current.onTranscript(m.role, m.text);
            break;
          case "audio":
            player.current?.enqueueBase64(m.data);
            setSpeaking(true);
            window.clearTimeout(speakTimer.current);
            speakTimer.current = window.setTimeout(() => setSpeaking(false), 600);
            break;
          case "interrupted":
            player.current?.flush();
            setSpeaking(false);
            break;
          case "alert":
            h.current.onAlert(m.alert);
            break;
          case "checkin":
            h.current.onCheckIn();
            break;
          case "info":
            setMessage(m.message);
            break;
          case "error":
            setMessage(m.message);
            cleanup();
            setStatus("error");
            break;
          case "ended":
            cleanup();
            setStatus("idle");
            break;
        }
      };
      socket.onclose = () => {
        if (ws.current === socket) {
          cleanup();
          setStatus((s) => (s === "error" ? s : "idle"));
        }
      };

      socket.send(JSON.stringify({ type: "start" }));
      mic.current = new MicCapture();
      await mic.current.start(
        (pcm) => socket.readyState === 1 && socket.send(pcm),
        (l) => setLevel(l),
      );
    } catch (err) {
      cleanup();
      const msg = err instanceof Error ? err.message : "";
      if (msg === "unreachable") {
        setStatus("unavailable");
        setMessage("Voice server isn't running. Using text chat.");
      } else if (/permission|denied|notallowed/i.test(msg) || (err as DOMException)?.name === "NotAllowedError") {
        setStatus("error");
        setMessage("Microphone access was blocked. Allow the microphone in your browser and try again.");
      } else {
        setStatus("error");
        setMessage(msg || "Could not start voice.");
      }
    }
  }, [cleanup]);

  const sendText = useCallback((text: string) => {
    if (ws.current?.readyState === 1) ws.current.send(JSON.stringify({ type: "text", text }));
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  return { status, level, speaking, mock, message, start, stop, sendText };
}
