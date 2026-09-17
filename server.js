// Jarvis: a voice-only personal agent.
//   browser mic  --ws-->  this server  --ws-->  Deepgram Voice Agent (STT -> Claude via Deepgram -> TTS)
//   Deepgram TTS audio  --ws-->  browser  --> plays directly (no avatar, no video)
//
// When Claude decides to use a tool (web search, reminders, calendar, email), Deepgram sends a
// FunctionCallRequest over this same socket; the server runs the tool locally and replies with a
// FunctionCallResponse. All API keys and OAuth tokens stay on the server.
import "dotenv/config";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { FUNCTION_DEFINITIONS, callFunction } from "./lib/functions.js";
import * as google from "./lib/google.js";
import * as reminders from "./lib/reminders.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  ANTHROPIC_API_KEY,
  THINK_MODEL = "claude-sonnet-5",
  SPEAK_MODEL = "flux-kit-en",
  LISTEN_MODEL = "flux-general-en",
  FLUX_EOT_THRESHOLD,
  FLUX_EAGER_EOT_THRESHOLD,
  FLUX_EOT_TIMEOUT_MS,
  GOOGLE_CLIENT_ID = "",
  GOOGLE_CLIENT_SECRET = "",
  PORT = 4400,
} = process.env;

// API keys live here at runtime. They start from .env and can be replaced from the page (POST /api/keys),
// which also writes them back to .env so they survive a restart.
const ENV_PATH = path.join(__dirname, ".env");
const keys = {
  deepgram: process.env.DEEPGRAM_API_KEY || "",
  brave: process.env.BRAVE_API_KEY || "",
};
let google_ = { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET };

function saveKeyToEnv(name, value) {
  let text = "";
  try { text = fs.readFileSync(ENV_PATH, "utf8"); } catch {}
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  text = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, "")}\n${line}\n`;
  fs.writeFileSync(ENV_PATH, text);
}
const mask = (k) => (k ? `••••${k.slice(-4)}` : "");

// Prompts live in prompts/*.md and are described by prompts/index.json — same mechanism as the
// talking-avatar-starter project this was forked from, kept in case you want more than one persona.
const PROMPTS_DIR = path.join(__dirname, "prompts");
function loadPrompts() {
  const index = JSON.parse(fs.readFileSync(path.join(PROMPTS_DIR, "index.json"), "utf8"));
  return index.map((entry) => {
    const text = fs.readFileSync(path.join(PROMPTS_DIR, entry.file), "utf8");
    if (text.length > 25000) console.warn(`[warn] ${entry.file} is ${text.length} chars; Deepgram caps prompts at 25,000`);
    return { ...entry, text };
  });
}
let PROMPTS = loadPrompts();

function fillPrompt(text, fields = [], values = {}) {
  let out = text;
  for (const f of fields) {
    const value = (values[f.key] || "").trim();
    if (!value && f.required) throw new Error(`Missing required field: ${f.label || f.key}`);
    out = out.replace(new RegExp(`\\[${f.key}[^\\]]*\\]`, "g"), value);
  }
  return out;
}

const DEEPGRAM_AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse";
const SAMPLE_RATE = 16000;

function buildSettings(promptEntry, values, voice = SPEAK_MODEL) {
  const think = {
    provider: { type: "anthropic", model: THINK_MODEL },
    prompt: fillPrompt(promptEntry.text, promptEntry.fields, values),
    functions: FUNCTION_DEFINITIONS,
  };
  // Default: Deepgram brokers the Anthropic call with its own credentials.
  // Optional: bring your own Anthropic key to use any model (e.g. claude-opus-5).
  if (ANTHROPIC_API_KEY) {
    think.endpoint = {
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    };
  }
  const listenProvider = { type: "deepgram", model: LISTEN_MODEL };
  if (LISTEN_MODEL.startsWith("flux")) {
    listenProvider.version = "v2";
    if (FLUX_EOT_THRESHOLD) listenProvider.eot_threshold = Number(FLUX_EOT_THRESHOLD);
    if (FLUX_EAGER_EOT_THRESHOLD) listenProvider.eager_eot_threshold = Number(FLUX_EAGER_EOT_THRESHOLD);
    if (FLUX_EOT_TIMEOUT_MS) listenProvider.eot_timeout_ms = Number(FLUX_EOT_TIMEOUT_MS);
  }
  const settings = {
    type: "Settings",
    audio: {
      input: { encoding: "linear16", sample_rate: SAMPLE_RATE },
      output: { encoding: "linear16", sample_rate: SAMPLE_RATE, container: "none" },
    },
    agent: {
      language: "en",
      listen: { provider: listenProvider },
      think,
      speak: { provider: { type: "deepgram", model: voice } },
    },
  };
  if (voice.startsWith("flux")) settings.agent.speak.provider.version = "v2";
  if (promptEntry.greeting) settings.agent.greeting = promptEntry.greeting;
  return settings;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Deepgram TTS voices. Aura lives on /v1/models; Flux TTS (flux-{voice}-{lang}) is a separate
// catalog on /v2/models and never appears in /v1/models, so both must be fetched and merged.
let voiceCache = { at: 0, list: [] };
function toVoiceOption(m, group) {
  const meta = m.metadata || {};
  const lang = (m.languages || [])[0] || "";
  const gender = (meta.tags || []).find((t) => t === "feminine" || t === "masculine") || "";
  const display = meta.display_name || m.name.replace(/^\w/, (c) => c.toUpperCase());
  const bits = [meta.accent, gender].filter(Boolean).join(", ");
  return {
    id: m.canonical_name,
    name: `${display}${bits ? ` — ${bits}` : ""}${lang && !lang.startsWith("en") ? ` (${lang})` : ""}`,
    lang,
    architecture: m.architecture,
    group,
    sample: meta.sample || null,
  };
}
async function listVoices() {
  if (Date.now() - voiceCache.at < 10 * 60 * 1000 && voiceCache.list.length) return voiceCache.list;
  const headers = { Authorization: `Token ${keys.deepgram}` };
  const [auraRes, fluxRes] = await Promise.all([
    fetch("https://api.deepgram.com/v1/models", { headers }),
    fetch("https://api.deepgram.com/v2/models", { headers }),
  ]);
  if (!auraRes.ok) throw new Error(`Deepgram models ${auraRes.status}: ${await auraRes.text()}`);
  if (!fluxRes.ok) throw new Error(`Deepgram v2 models ${fluxRes.status}: ${await fluxRes.text()}`);
  const [auraBody, fluxBody] = await Promise.all([auraRes.json(), fluxRes.json()]);

  const flux = (fluxBody.tts || []).map((m) => toVoiceOption(m, "Flux (recommended)"));
  const auraEnglish = [];
  const auraOther = [];
  for (const m of auraBody.tts || []) {
    const isEnglish = ((m.languages || [])[0] || "").startsWith("en");
    (isEnglish ? auraEnglish : auraOther).push(toVoiceOption(m, isEnglish ? "Aura — English" : "Aura — Other languages"));
  }
  for (const group of [flux, auraEnglish, auraOther]) group.sort((a, b) => a.name.localeCompare(b.name));

  const list = [...flux, ...auraEnglish, ...auraOther];
  voiceCache = { at: Date.now(), list };
  return list;
}

app.get("/api/voices", async (_req, res) => {
  try {
    res.json({ defaultVoice: SPEAK_MODEL, voices: await listVoices() });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// Save keys pasted on the page. Deepgram is checked against the provider; Brave has no cheap
// no-op endpoint to probe, so it's accepted as-is and only proven wrong the first time it's used.
app.post("/api/keys", async (req, res) => {
  const result = {};
  const deepgram = (req.body?.deepgram || "").trim();
  const brave = (req.body?.brave || "").trim();
  if (deepgram) {
    const r = await fetch("https://api.deepgram.com/v1/projects", { headers: { Authorization: `Token ${deepgram}` } }).catch(() => null);
    if (r?.ok) { keys.deepgram = deepgram; voiceCache = { at: 0, list: [] }; saveKeyToEnv("DEEPGRAM_API_KEY", deepgram); result.deepgram = "ok"; }
    else result.deepgram = `Deepgram rejected this key${r ? ` (${r.status})` : ""}`;
  }
  if (brave) {
    keys.brave = brave;
    saveKeyToEnv("BRAVE_API_KEY", brave);
    result.brave = "ok";
  }
  res.json({ ...result, keyHints: { deepgram: mask(keys.deepgram), brave: mask(keys.brave) } });
});

// --- Google OAuth (Gmail + Calendar) ---------------------------------------------------------
function redirectUri(req) {
  return `${req.protocol}://${req.get("host")}/auth/google/callback`;
}

app.post("/api/google-app-keys", (req, res) => {
  const clientId = (req.body?.clientId || "").trim();
  const clientSecret = (req.body?.clientSecret || "").trim();
  if (clientId) { google_.clientId = clientId; saveKeyToEnv("GOOGLE_CLIENT_ID", clientId); }
  if (clientSecret) { google_.clientSecret = clientSecret; saveKeyToEnv("GOOGLE_CLIENT_SECRET", clientSecret); }
  res.json({ ok: true, hasClientId: Boolean(google_.clientId), hasClientSecret: Boolean(google_.clientSecret) });
});

app.get("/auth/google", (req, res) => {
  if (!google_.clientId) return res.status(400).send("Set GOOGLE_CLIENT_ID first (see the keys panel).");
  const url = google.buildAuthUrl({ clientId: google_.clientId, redirectUri: redirectUri(req) });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error));
    await google.exchangeCode({
      code: String(req.query.code || ""),
      clientId: google_.clientId,
      clientSecret: google_.clientSecret,
      redirectUri: redirectUri(req),
    });
    res.send("<p>Google connected. You can close this tab and go back to Jarvis.</p>");
  } catch (err) {
    res.status(500).send(`<p>Google connect failed: ${err.message}</p>`);
  }
});

app.post("/api/google-disconnect", (_req, res) => {
  google.disconnect();
  res.json({ ok: true });
});

// --- Reminders (also browsable outside a live conversation) ----------------------------------
app.get("/api/reminders", (req, res) => {
  res.json({ reminders: reminders.listReminders({ include_completed: req.query.include_completed === "true" }) });
});

app.get("/api/config", (_req, res) => {
  PROMPTS = loadPrompts(); // re-read on page load so prompt edits don't need a restart
  res.json({
    sampleRate: SAMPLE_RATE,
    thinkModel: THINK_MODEL,
    thinkVia: ANTHROPIC_API_KEY ? "your Anthropic key" : "Deepgram-brokered Anthropic",
    deepgramConfigured: Boolean(keys.deepgram),
    keyHints: { deepgram: mask(keys.deepgram), brave: mask(keys.brave) },
    braveConfigured: Boolean(keys.brave),
    googleAppConfigured: Boolean(google_.clientId && google_.clientSecret),
    googleConnected: google.isConnected(),
    prompts: PROMPTS.map(({ id, name, fields = [] }) => ({ id, name, fields })),
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/agent" });

// One upstream Deepgram socket per browser socket. Binary frames are audio in both directions;
// text frames are JSON control/events, including FunctionCallRequest/FunctionCallResponse.
wss.on("connection", async (client, req) => {
  const params = new URL(req.url, "http://localhost").searchParams;
  const promptEntry = PROMPTS.find((p) => p.id === params.get("prompt")) || PROMPTS[0];
  const values = Object.fromEntries((promptEntry.fields || []).map((f) => [f.key, params.get(f.key) || ""]));

  let voice = SPEAK_MODEL;
  const requested = params.get("voice");
  if (requested && requested !== SPEAK_MODEL) {
    try {
      if ((await listVoices()).some((v) => v.id === requested)) voice = requested;
      else console.warn(`[session] unknown voice "${requested}", using ${SPEAK_MODEL}`);
    } catch (err) {
      console.warn(`[session] could not verify voice: ${err.message}`);
    }
  }

  let settings;
  try {
    settings = buildSettings(promptEntry, values, voice);
  } catch (err) {
    client.send(JSON.stringify({ type: "Error", error: err.message }));
    client.close();
    return;
  }
  console.log(`[session] prompt=${promptEntry.id} voice=${voice}`);

  const upstream = new WebSocket(DEEPGRAM_AGENT_URL, {
    headers: { Authorization: `Token ${keys.deepgram}` },
  });
  const pending = [];
  let keepAlive;
  let hideKickoffEcho = false;

  const sendClient = (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  };
  const sendUpstream = (obj) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(obj));
  };

  // Run every function call in a FunctionCallRequest, then answer each with its own FunctionCallResponse.
  async function handleFunctionCallRequest(msg) {
    const ctx = {
      braveKey: keys.brave,
      googleCreds: { clientId: google_.clientId, clientSecret: google_.clientSecret },
      googleConnected: google.isConnected(),
    };
    for (const call of msg.functions || []) {
      let content;
      try {
        const args = call.arguments ? JSON.parse(call.arguments) : {};
        const result = await callFunction(call.name, args, ctx);
        content = JSON.stringify(result);
      } catch (err) {
        content = JSON.stringify({ error: String(err.message || err) });
      }
      console.log(`[tool] ${call.name} ->`, content.slice(0, 200));
      sendUpstream({ type: "FunctionCallResponse", id: call.id, name: call.name, content });
    }
  }

  upstream.on("open", () => {
    upstream.send(JSON.stringify(settings));
    for (const msg of pending) upstream.send(msg.data, { binary: msg.isBinary });
    pending.length = 0;
    keepAlive = setInterval(() => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: "KeepAlive" }));
    }, 8000);
  });
  upstream.on("message", (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "Error" || msg.type === "Warning") console.warn("[deepgram]", msg);
        if (msg.type === "SettingsApplied" && promptEntry.kickoff) {
          hideKickoffEcho = true;
          upstream.send(JSON.stringify({ type: "InjectUserMessage", content: promptEntry.kickoff }));
        }
        if (hideKickoffEcho && msg.type === "ConversationText" && msg.role === "user" && msg.content === promptEntry.kickoff) {
          hideKickoffEcho = false;
          return; // don't show the nudge in the transcript
        }
        if (msg.type === "FunctionCallRequest") {
          handleFunctionCallRequest(msg); // fire and forget; responses stream back over `upstream`
          return; // Deepgram doesn't need this echoed to the browser
        }
      } catch {}
    }
    sendClient(data, isBinary);
  });
  upstream.on("close", (code, reason) => {
    console.log(`[deepgram] closed ${code} ${reason}`);
    sendClient(JSON.stringify({ type: "ProxyClosed", code, reason: reason.toString() }), false);
    client.close();
  });
  upstream.on("error", (err) => {
    console.error("[deepgram] error", err.message);
    sendClient(JSON.stringify({ type: "Error", error: `Deepgram connection failed: ${err.message}` }), false);
  });

  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else pending.push({ data, isBinary });
  });
  client.on("close", () => {
    clearInterval(keepAlive);
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
  });
});

let listenErrorReported = false;
function handleListenError(err) {
  if (listenErrorReported) return;
  listenErrorReported = true;
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Close the other app, or set PORT=4401 in .env and try again.`);
    process.exit(1);
  }
  throw err;
}
wss.on("error", handleListenError);
server.on("error", handleListenError);

server.listen(PORT, () => {
  console.log("Jarvis is running.");
  console.log(`Open this in Chrome:  http://localhost:${PORT}`);
  if (!keys.deepgram) {
    console.log("Then paste your Deepgram API key into the box at the top of the page.");
  }
  console.log("Press Ctrl+C here to stop.");
});
