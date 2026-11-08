// HumanLoop voice bridge.
// Browser <-WebSocket(/voice)-> this server <-HTTP/2 bidirectional stream-> Amazon Bedrock (Nova Sonic).
// AWS credentials come from the standard credential chain (env vars, SSO, ~/.aws). They never reach the browser.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttp2Handler } from "@smithy/node-http-handler";

const PORT = Number(process.env.PORT || 8787);
const REGION = process.env.AWS_REGION || "us-east-1";
const MODEL_ID = process.env.NOVA_SONIC_MODEL_ID || "amazon.nova-2-sonic-v1:0";
const VOICE_ID = process.env.NOVA_VOICE_ID || "matthew";
const VISION_MODEL_ID = process.env.VISION_MODEL_ID || "us.amazon.nova-lite-v1:0";
const MOCK = process.env.MOCK_VOICE === "1";
const SESSION_LIMIT_MS = 7.5 * 60 * 1000; // Nova 2 Sonic connections last at most ~8 minutes

const SYSTEM_PROMPT = `You are Dr. Miller's care assistant on the HumanLoop app, speaking by voice with Alice, an older adult living independently.
Speak warmly, in short simple sentences, one question at a time. Never use medical jargon. Never diagnose.
Start with a friendly good morning and ask how she is feeling. Then ask 2 to 4 focused follow-up questions to understand any problem (when it started, how bad, meals, medicines, sleep).
Call record_check_in as soon as Alice has told you how she feels.
Call notify_nurse when she describes a worrying symptom: dizziness or shakiness, swelling, trouble breathing, chest pain, a fall, confusion, a missed medication, or anything she is scared about. Include a short plain-language summary a nurse can act on.
If she describes chest pain, severe trouble breathing, or fainting, tell her to call emergency services and notify the nurse as urgent.
Never ask her to do a medical test herself (for example checking blood sugar); the nurse will do that.
If she shares a photo you will receive a text description of it; mention it naturally.
Only discuss Alice. Politely refuse to discuss any other resident.`;

const TOOLS = [
  {
    toolSpec: {
      name: "record_check_in",
      description: "Record that Alice completed her daily check-in and how she says she feels.",
      inputSchema: {
        json: JSON.stringify({
          type: "object",
          properties: {
            mood: { type: "string", description: "good, tired, or unwell" },
            note: { type: "string", description: "One short sentence in Alice's words" },
          },
          required: ["mood"],
        }),
      },
    },
  },
  {
    toolSpec: {
      name: "notify_nurse",
      description: "Send an alert with a summary to the registered nurse. Use for any concerning symptom.",
      inputSchema: {
        json: JSON.stringify({
          type: "object",
          properties: {
            urgency: { type: "string", description: "routine, high, or urgent" },
            reason: { type: "string", description: "Short title, e.g. 'Dizzy and shaky since waking'" },
            summary: { type: "string", description: "2-3 plain sentences for the nurse" },
            requested_action: { type: "string", description: "e.g. 'Nurse to check blood sugar'" },
          },
          required: ["urgency", "reason", "summary"],
        }),
      },
    },
  },
];

const alerts = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Bedrock client ----------
let bedrock;
function getBedrock() {
  bedrock ??= new BedrockRuntimeClient({
    region: REGION,
    requestHandler: new NodeHttp2Handler({
      requestTimeout: 300000,
      sessionTimeout: 300000,
      disableConcurrentStreams: false,
      maxConcurrentStreams: 20,
    }),
  });
  return bedrock;
}

// Async queue that feeds the request stream.
class EventQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
    this.initializing = true;
  }
  push(obj) {
    if (this.closed) return;
    const item = { chunk: { bytes: new TextEncoder().encode(JSON.stringify(obj)) } };
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters) w({ value: undefined, done: true });
    this.waiters = [];
  }
  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        if (this.initializing) await sleep(30);
        if (this.items.length) return { value: this.items.shift(), done: false };
        if (this.closed) return { value: undefined, done: true };
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function addAlert(partial, session) {
  const alert = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    patient: "Alice",
    status: "new",
    urgency: "high",
    reason: "Check-in concern",
    summary: "",
    requestedAction: "",
    photoDescription: session.photoDescription || null,
    transcript: session.transcript.slice(-8),
    ...partial,
  };
  alerts.unshift(alert);
  return alert;
}

// ---------- Nova Sonic session ----------
class NovaSession {
  constructor(ws) {
    this.ws = ws;
    this.queue = new EventQueue();
    this.promptName = randomUUID();
    this.audioContent = randomUUID();
    this.roles = new Map();
    this.stages = new Map();
    this.pendingTool = null;
    this.transcript = [];
    this.photoDescription = null;
    this.ended = false;
  }
  emit(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }
  send(event) {
    this.queue.push({ event });
  }
  textBlock(role, text, interactive = true) {
    const contentName = randomUUID();
    this.send({
      contentStart: {
        promptName: this.promptName,
        contentName,
        type: "TEXT",
        interactive,
        role,
        textInputConfiguration: { mediaType: "text/plain" },
      },
    });
    this.send({ textInput: { promptName: this.promptName, contentName, content: text } });
    this.send({ contentEnd: { promptName: this.promptName, contentName } });
  }
  async start() {
    this.send({
      sessionStart: {
        inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 },
      },
    });
    this.send({
      promptStart: {
        promptName: this.promptName,
        textOutputConfiguration: { mediaType: "text/plain" },
        audioOutputConfiguration: {
          mediaType: "audio/lpcm",
          sampleRateHertz: 24000,
          sampleSizeBits: 16,
          channelCount: 1,
          voiceId: VOICE_ID,
          encoding: "base64",
          audioType: "SPEECH",
        },
        toolUseOutputConfiguration: { mediaType: "application/json" },
        toolConfiguration: { tools: TOOLS },
      },
    });
    this.textBlock("SYSTEM", SYSTEM_PROMPT);
    // Nudge the model to speak first.
    this.textBlock("USER", "Hello. Please greet Alice and begin her daily check-in.");
    this.send({
      contentStart: {
        promptName: this.promptName,
        contentName: this.audioContent,
        type: "AUDIO",
        interactive: true,
        role: "USER",
        audioInputConfiguration: {
          mediaType: "audio/lpcm",
          sampleRateHertz: 16000,
          sampleSizeBits: 16,
          channelCount: 1,
          audioType: "SPEECH",
          encoding: "base64",
        },
      },
    });
    setTimeout(() => (this.queue.initializing = false), 400);

    const command = new InvokeModelWithBidirectionalStreamCommand({
      modelId: MODEL_ID,
      body: this.queue,
    });
    const response = await getBedrock().send(command);
    this.emit({ type: "ready", mock: false });
    this.limitTimer = setTimeout(() => {
      this.emit({ type: "info", message: "Session time limit reached. Tap the mic to continue." });
      this.stop();
    }, SESSION_LIMIT_MS);
    this.readLoop(response).catch((err) => this.fail(err));
  }
  audio(buf) {
    if (this.ended) return;
    this.send({
      audioInput: {
        promptName: this.promptName,
        contentName: this.audioContent,
        content: buf.toString("base64"),
      },
    });
  }
  text(text) {
    if (this.ended) return;
    this.textBlock("USER", text);
  }
  async readLoop(response) {
    for await (const item of response.body) {
      if (item.chunk?.bytes) {
        const json = JSON.parse(new TextDecoder().decode(item.chunk.bytes));
        this.handle(json.event || {});
      } else if (item.modelStreamErrorException || item.internalServerException) {
        throw new Error(
          (item.modelStreamErrorException || item.internalServerException).message || "Model stream error",
        );
      }
    }
    this.emit({ type: "ended" });
  }
  handle(ev) {
    if (ev.contentStart) {
      const { contentId, role, additionalModelFields } = ev.contentStart;
      this.roles.set(contentId, role);
      try {
        this.stages.set(contentId, JSON.parse(additionalModelFields || "{}").generationStage);
      } catch {
        /* ignore */
      }
    } else if (ev.textOutput) {
      const { contentId, content } = ev.textOutput;
      const role = ev.textOutput.role || this.roles.get(contentId);
      if (content.includes('"interrupted"')) {
        this.emit({ type: "interrupted" });
        return;
      }
      if (role === "ASSISTANT" && this.stages.get(contentId) === "FINAL") return; // avoid duplicate text
      this.transcript.push(`${role === "USER" ? "Alice" : "Assistant"}: ${content}`);
      this.emit({ type: "transcript", role: role === "USER" ? "user" : "assistant", text: content });
    } else if (ev.audioOutput) {
      this.emit({ type: "audio", data: ev.audioOutput.content });
    } else if (ev.toolUse) {
      this.pendingTool = ev.toolUse;
    } else if (ev.contentEnd) {
      if (ev.contentEnd.type === "TOOL" && this.pendingTool) {
        const tool = this.pendingTool;
        this.pendingTool = null;
        this.runTool(tool);
      } else if (ev.contentEnd.stopReason === "INTERRUPTED") {
        this.emit({ type: "interrupted" });
      }
    }
  }
  runTool(tool) {
    let args = {};
    try {
      args = JSON.parse(tool.content || "{}");
    } catch {
      /* ignore */
    }
    let result;
    if (tool.toolName === "notify_nurse") {
      const alert = addAlert(
        {
          urgency: args.urgency,
          reason: args.reason,
          summary: args.summary,
          requestedAction: args.requested_action || "",
        },
        this,
      );
      this.emit({ type: "alert", alert });
      result = { ok: true, message: "The nurse team has been notified." };
    } else if (tool.toolName === "record_check_in") {
      this.emit({ type: "checkin", mood: args.mood, note: args.note });
      result = { ok: true };
    } else {
      result = { ok: false, error: `Unknown tool ${tool.toolName}` };
    }
    const contentName = randomUUID();
    this.send({
      contentStart: {
        promptName: this.promptName,
        contentName,
        interactive: false,
        type: "TOOL",
        role: "TOOL",
        toolResultInputConfiguration: {
          toolUseId: tool.toolUseId,
          type: "TEXT",
          textInputConfiguration: { mediaType: "text/plain" },
        },
      },
    });
    this.send({ toolResult: { promptName: this.promptName, contentName, content: JSON.stringify(result) } });
    this.send({ contentEnd: { promptName: this.promptName, contentName } });
  }
  fail(err) {
    console.error("[nova]", err);
    this.emit({ type: "error", message: err?.message || "Voice session failed" });
    this.stop();
  }
  stop() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.limitTimer);
    this.send({ contentEnd: { promptName: this.promptName, contentName: this.audioContent } });
    this.send({ promptEnd: { promptName: this.promptName } });
    this.send({ sessionEnd: {} });
    this.queue.close();
  }
}

// ---------- Mock session (no AWS needed) ----------
class MockSession {
  constructor(ws) {
    this.ws = ws;
    this.transcript = [];
    this.photoDescription = null;
    this.frames = 0;
    this.step = 0;
    this.timers = [];
    this.ended = false;
  }
  emit(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }
  say(role, text, delay) {
    this.timers.push(
      setTimeout(() => {
        this.transcript.push(`${role === "user" ? "Alice" : "Assistant"}: ${text}`);
        this.emit({ type: "transcript", role, text });
      }, delay),
    );
  }
  async start() {
    this.emit({ type: "ready", mock: true });
    this.say("assistant", "Good morning, Alice! How are you feeling today?", 500);
  }
  audio() {
    // After a few seconds of mic audio, play a canned exchange.
    this.frames++;
    if (this.step === 0 && this.frames > 120) {
      this.step = 1;
      this.say("user", "I feel a bit shaky and dizzy this morning.", 0);
      this.emit({ type: "checkin", mood: "unwell", note: "Shaky and dizzy" });
      this.say("assistant", "I'm sorry to hear that. Have you had any breakfast yet?", 1200);
    } else if (this.step === 1 && this.frames > 320) {
      this.step = 2;
      this.say("user", "No, I haven't eaten and I'm sweating a bit.", 0);
      this.say("assistant", "Thank you. I'm letting your nurse know now. Please sit down and stay where you are.", 1200);
      this.timers.push(
        setTimeout(() => {
          const alert = addAlert(
            {
              urgency: "high",
              reason: "Shaky, dizzy and sweaty since waking",
              summary: "Alice reports shakiness, dizziness and sweating. She has not eaten this morning.",
              requestedAction: "Nurse to check blood sugar",
            },
            this,
          );
          this.emit({ type: "alert", alert });
        }, 1500),
      );
    }
  }
  text(text) {
    this.transcript.push(`Alice: ${text}`);
    this.say("assistant", "Thank you for telling me. I'm here if you'd like to share anything else.", 900);
  }
  stop() {
    this.ended = true;
    this.timers.forEach(clearTimeout);
    this.emit({ type: "ended" });
  }
}

// ---------- HTTP ----------
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function describePhoto(bytes, mime) {
  if (MOCK) {
    return "Both ankles look swollen with shiny skin and a visible sock-line indentation. This may be consistent with fluid swelling (edema); a nurse should review.";
  }
  const format = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpeg";
  const out = await getBedrock().send(
    new ConverseCommand({
      modelId: VISION_MODEL_ID,
      messages: [
        {
          role: "user",
          content: [
            { image: { format, source: { bytes } } },
            {
              text: "You are assisting a nurse. In two short sentences describe only what is visibly present (swelling, redness, skin colour, wounds, facial expression). Do not diagnose.",
            },
          ],
        },
      ],
      inferenceConfig: { maxTokens: 250, temperature: 0.2 },
    }),
  );
  return out.output?.message?.content?.[0]?.text?.trim() || "No description available.";
}

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const sessions = new Set();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, { ok: true, mock: MOCK, region: REGION, model: MODEL_ID });
    }
    if (req.method === "GET" && url.pathname === "/api/alerts") return json(res, 200, alerts);
    const ack = url.pathname.match(/^\/api\/alerts\/([^/]+)\/ack$/);
    if (req.method === "POST" && ack) {
      const a = alerts.find((x) => x.id === ack[1]);
      if (!a) return json(res, 404, { error: "Not found" });
      a.status = "acknowledged";
      return json(res, 200, a);
    }
    if (req.method === "POST" && url.pathname === "/api/describe-photo") {
      const bytes = await readBody(req);
      const description = await describePhoto(bytes, req.headers["content-type"] || "image/jpeg");
      for (const s of sessions) s.photoDescription = description;
      return json(res, 200, { description });
    }
    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("[http]", err);
    json(res, 500, { error: err.message || "Server error" });
  }
});

const wss = new WebSocketServer({ server, path: "/voice" });
wss.on("connection", (ws) => {
  let session = null;
  ws.on("message", async (data, isBinary) => {
    try {
      if (isBinary) return session?.audio(MOCK ? null : Buffer.from(data));
      const msg = JSON.parse(data.toString());
      if (msg.type === "start" && !session) {
        session = MOCK ? new MockSession(ws) : new NovaSession(ws);
        sessions.add(session);
        await session.start();
      } else if (msg.type === "text") session?.text(String(msg.text || ""));
      else if (msg.type === "stop") session?.stop();
    } catch (err) {
      console.error("[ws]", err);
      ws.send(JSON.stringify({ type: "error", message: err.message || "Voice error" }));
      session?.stop();
    }
  });
  ws.on("close", () => {
    session?.stop();
    sessions.delete(session);
  });
});

server.listen(PORT, () => {
  console.log(
    `HumanLoop voice server on :${PORT} | ${MOCK ? "MOCK mode (no AWS)" : `Bedrock ${MODEL_ID} in ${REGION}`}`,
  );
});
