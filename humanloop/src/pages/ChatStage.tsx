import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Icon } from "../components/Icon";
import { Bot } from "../components/Bot";
import { useApp } from "../state";
import { useVoice } from "../lib/useVoice";
import { resizeImage } from "../lib/audio";
import { navigate } from "../lib/router";
import { useBrowserListen } from "../lib/useBrowserListen";
import { cancelSpeech, onSpeakingChange, speak, ttsSupported } from "../lib/tts";

const quickReplies = ["Feeling good", "A bit tired", "Not well"];

// Where the sharp "focused" message sits, as a fraction of the chat height from the top.
const FOCUS_RATIO = 0.62;

// Scripted replies for the demo when real Nova Sonic isn't connected.
const scriptedReplies = (message: string): { replies: string[]; notify: boolean } => {
  const m = message.toLowerCase();
  if (/chest|breath|faint|fell|fall|collapse/.test(m)) {
    return {
      replies: [
        "That sounds serious, Alice. If you feel very unwell, please call emergency services right now.",
        "I’m alerting your nurse straight away. Please stay where you are.",
      ],
      notify: true,
    };
  }
  if (/dizz|shak|sweat|swollen|swelling|ankle|pain|hurt|not well|unwell|sick|ill\b/.test(m)) {
    return {
      replies: [
        "I’m sorry you’re not feeling well, Alice. Can you tell me a little more about what feels wrong?",
        "I’ll notify the nurse team so someone can check in with you.",
      ],
      notify: true,
    };
  }
  if (/tired|sleepy|weary/.test(m)) return { replies: ["Thank you for telling me. Take things gently today and rest when you need to."], notify: false };
  if (/good|great|fine|well|okay|ok\b|happy/.test(m)) return { replies: ["That’s lovely to hear, Alice. Keep taking good care of yourself today."], notify: false };
  return { replies: ["Thank you for telling me, Alice. I’m here if you’d like to share anything else."], notify: false };
};

export default function ChatStage() {
  const app = useApp();
  const { messages, addMessage, updateMessage, setCheckedIn, nurseNotified, setNurseNotified, prefs } = app;
  const [draft, setDraft] = useState("");
  const [busyPhoto, setBusyPhoto] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const voice = useVoice({
    onTranscript: (role, text) => {
      // The assistant's spoken greeting replaces the built-in text greeting instead of repeating it.
      if (role === "assistant" && messages.length === 1 && messages[0].id === 1) {
        updateMessage(1, { text });
        return;
      }
      addMessage({ sender: role === "user" ? "alice" : "nurse", text });
      if (role === "user") setCheckedIn(true);
    },
    onAlert: () => setNurseNotified(true),
    onCheckIn: () => setCheckedIn(true),
  });

  // ---- Focus carousel: the message at the focus line is sharp, the rest blur and fade with distance. ----
  const scroller = useRef<HTMLElement>(null);
  const spacerTop = useRef<HTMLDivElement>(null);
  const spacerBottom = useRef<HTMLDivElement>(null);
  const raf = useRef(0);

  const updateFocus = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const h = el.clientHeight;
    const focalY = el.getBoundingClientRect().top + h * FOCUS_RATIO;
    const nodes = Array.from(el.querySelectorAll<HTMLElement>("[data-msg]"));
    const centers = nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    // f = how many messages away from the focus line (0 = focused, 1 = neighbour, >1.4 = hidden)
    const pitch = centers.length > 1 ? Math.max(60, (centers[centers.length - 1] - centers[0]) / (centers.length - 1)) : h * 0.3;
    nodes.forEach((n, i) => {
      const f = Math.abs(centers[i] - focalY) / pitch;
      n.style.setProperty("--f", f.toFixed(3));
      n.dataset.far = f > 1.8 ? "1" : "0";
    });
  }, []);

  const scrollToLatest = useCallback(
    (smooth = true) => {
      const el = scroller.current;
      if (!el) return;
      const items = el.querySelectorAll<HTMLElement>("[data-msg]");
      const last = items[items.length - 1];
      if (!last) return;
      el.scrollTo({ top: last.offsetTop + last.offsetHeight / 2 - el.clientHeight * FOCUS_RATIO, behavior: smooth ? "smooth" : "auto" });
    },
    [],
  );

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const layout = () => {
      const h = el.clientHeight;
      if (spacerTop.current) spacerTop.current.style.height = `${Math.max(0, h * FOCUS_RATIO - 30)}px`;
      if (spacerBottom.current) spacerBottom.current.style.height = `${h * (1 - FOCUS_RATIO)}px`;
      el.style.scrollPaddingTop = `${(2 * FOCUS_RATIO - 1) * h}px`;
      updateFocus();
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(el);
    const onScroll = () => {
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(updateFocus);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf.current);
    };
  }, [updateFocus]);

  // A new message (or photo note) slides into focus.
  useEffect(() => {
    scrollToLatest(true);
    const t = window.setTimeout(updateFocus, 60);
    return () => window.clearTimeout(t);
  }, [messages, nurseNotified, scrollToLatest, updateFocus]);

  const live = voice.status === "live";

  // Browser text-to-speech: the bot reads Dr. Miller's replies aloud when real Nova Sonic audio isn't playing.
  const [readAloud, setReadAloud] = useState(true);
  const [ttsSpeaking, setTtsSpeaking] = useState(false);
  const spoken = useRef(new Set(messages.map((m) => `${m.id}|${m.text}`)));
  const novaAudio = live && !voice.mock;

  useEffect(() => {
    onSpeakingChange(setTtsSpeaking);
    return () => {
      onSpeakingChange(null);
      cancelSpeech();
    };
  }, []);

  useEffect(() => {
    for (const m of messages) {
      const key = `${m.id}|${m.text}`;
      if (m.sender !== "nurse" || spoken.current.has(key)) continue;
      spoken.current.add(key);
      if (readAloud && !novaAudio) speak(m.text);
    }
  }, [messages, readAloud, novaAudio]);

  useEffect(() => {
    if (!readAloud || novaAudio) cancelSpeech();
  }, [readAloud, novaAudio]);

  // Browser speech-to-text conversation: listen -> reply (spoken) -> listen again.
  const sendRef = useRef<(t: string) => void>(() => {});
  const listen = useBrowserListen((t) => sendRef.current(t));
  const [browserMode, setBrowserMode] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!browserMode) return;
    if (listen.error) {
      setBrowserMode(false);
      setNotice(
        listen.error === "blocked"
          ? "Microphone access was blocked. Allow the microphone in your browser and try again."
          : "Speech recognition needs an internet connection in this browser.",
      );
      return;
    }
    if (ttsSpeaking) {
      listen.stop();
      return;
    }
    const t = window.setTimeout(() => listen.start(), 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserMode, ttsSpeaking, listen.listening, listen.error]);

  const stopBrowser = () => {
    setBrowserMode(false);
    listen.stop();
    cancelSpeech();
  };

  const send = (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    addMessage({ sender: "alice", text: clean });
    setCheckedIn(true);
    setDraft("");
    if (live) {
      voice.sendText(clean);
      return;
    }
    const { replies, notify } = scriptedReplies(clean);
    replies.forEach((reply, i) => window.setTimeout(() => addMessage({ sender: "nurse", text: reply }), 700 * (i + 1)));
    if (notify) window.setTimeout(() => setNurseNotified(true), 700 * replies.length);
  };
  sendRef.current = send;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    send(draft);
  };

  const onPhoto = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusyPhoto(true);
    try {
      const { blob, dataUrl } = await resizeImage(file);
      const id = addMessage({ sender: "alice", text: "Here’s a photo.", image: dataUrl, note: "Looking at your photo…" });
      setCheckedIn(true);
      try {
        const res = await fetch("/api/describe-photo", { method: "POST", headers: { "content-type": "image/jpeg" }, body: blob });
        if (!res.ok) throw new Error("describe failed");
        const { description } = (await res.json()) as { description: string };
        updateMessage(id, { note: description });
        if (live) voice.sendText(`Alice shared a photo. A vision model describes it as: ${description}`);
      } catch {
        updateMessage(id, { note: "Photo shared with your nurse. (Photo analysis isn’t available right now.)" });
      }
    } catch {
      addMessage({ sender: "nurse", text: "I couldn’t open that photo. Could you try another one?" });
    } finally {
      setBusyPhoto(false);
    }
  };

  const toggleVoice = async () => {
    if (browserMode) return stopBrowser();
    if (live || voice.status === "connecting") return voice.stop();
    setNotice(null);
    // Use real Nova Sonic if the server is connected to AWS; otherwise fall back to browser speech.
    try {
      const h = (await (await fetch("/api/health")).json()) as { ok?: boolean; mock?: boolean };
      if (h.ok && !h.mock) return void voice.start();
    } catch {
      /* server not running: use browser speech */
    }
    if (!listen.supported) {
      setNotice("Speech recognition isn’t supported in this browser. Try Chrome, Edge or Safari, or type instead.");
      return;
    }
    setBrowserMode(true);
    const greeting = messages.find((m) => m.sender === "nurse");
    if (greeting && readAloud) speak(greeting.text);
  };

  const status =
    voice.status === "connecting"
      ? "Connecting…"
      : voice.speaking || ttsSpeaking
        ? "Dr. Miller is speaking…"
        : browserMode
          ? listen.interim
            ? `“${listen.interim}”`
            : listen.listening
              ? "Listening…"
              : "Getting ready…"
          : voice.level > 0.02
            ? "Listening…"
            : "Go ahead, I’m listening";

  const botState =
    voice.speaking || ttsSpeaking
      ? "speaking"
      : (live && voice.level > 0.02) || (browserMode && listen.listening)
        ? "listening"
        : "idle";
  const voiceActive = live || voice.status === "connecting" || browserMode;

  return (
    <div className="stage-screen">
      <header className="stage-top">
        <button className="chat-back" type="button" aria-label="Back to home" onClick={() => navigate("/")}>
          <Icon name="arrow-left" size={28} />
        </button>
        {nurseNotified ? (
          <div className="stage-status alert" role="status" aria-live="polite">
            <span className="stage-status-label">Status</span>
            <strong>
              <Icon name="bell" size={20} /> Nurse is on the way
            </strong>
          </div>
        ) : (
          <span />
        )}
      </header>

      <section className="stage-bot">
        <Bot state={botState} level={voice.level} />
      </section>

      <main className="stage-messages" aria-live="polite" ref={scroller}>
        <div ref={spacerTop} aria-hidden="true" />
        {messages.map((m) => (
          <div
            className={`stage-msg ${m.sender}`}
            key={m.id}
            data-msg
            onClick={(e) => {
              const el = scroller.current;
              const n = e.currentTarget;
              if (el) el.scrollTo({ top: n.offsetTop + n.offsetHeight / 2 - el.clientHeight * FOCUS_RATIO, behavior: "smooth" });
            }}
          >
            {m.sender === "alice" && <small>You</small>}
            {m.image && <img src={m.image} alt="Photo shared by Alice" />}
            <p>“{m.text}”</p>
            {m.note && (
              <p className="stage-note">
                <b>Photo check:</b> {m.note}
              </p>
            )}
          </div>
        ))}
        <div ref={spacerBottom} aria-hidden="true" />
      </main>

      <footer className="chat-composer stage-controls">
        {(notice || voice.message) && <p className="voice-note">{notice || voice.message}</p>}

        {!voiceActive && (
          <div className="quick-replies">
            {quickReplies.map((r) => (
              <button type="button" key={r} onClick={() => send(r)}>
                {r}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={submit} className="chat-form">
          <input ref={fileInput} className="sr-only" type="file" accept="image/*" capture="environment" onChange={onPhoto} />
          <button
            type="button"
            className="round-btn light"
            aria-label="Share a photo"
            disabled={!prefs.camera || busyPhoto}
            onClick={() => fileInput.current?.click()}
          >
            <Icon name="camera" size={23} />
          </button>
          <label className="sr-only" htmlFor="stage-message">
            Message Dr. Miller
          </label>
          <input
            id="stage-message"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type how you’re feeling..."
            autoComplete="off"
          />
          <button
            type="button"
            className={`round-btn mic ${live || browserMode ? "on" : ""}`}
            aria-label={live || browserMode ? "Stop voice" : "Talk to Dr. Miller"}
            disabled={!prefs.voice}
            onClick={() => void toggleVoice()}
          >
            <Icon name={live || browserMode ? "stop" : "mic"} size={23} />
          </button>
          <button type="submit" className="round-btn" aria-label="Send message" disabled={!draft.trim()}>
            <Icon name="send" size={23} />
          </button>
        </form>
      </footer>
    </div>
  );
}
