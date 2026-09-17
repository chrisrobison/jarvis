// Browser orchestration:
//   mic -> AudioWorklet (PCM16 @ 16 kHz) -> ws /agent -> Deepgram Voice Agent
//   Deepgram TTS PCM16 -> played directly via Web Audio (no avatar, no video)
const els = {
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  status: document.getElementById("status"),
  orb: document.getElementById("orb"),
  transcript: document.getElementById("transcript"),
  meta: document.getElementById("meta"),
  mic: document.getElementById("mic"),
  micPerm: document.getElementById("micPerm"),
  levelBar: document.getElementById("levelBar"),
  voice: document.getElementById("voice"),
  preview: document.getElementById("preview"),
  deepgramKey: document.getElementById("deepgramKey"),
  braveKey: document.getElementById("braveKey"),
  saveKeys: document.getElementById("saveKeys"),
  keysState: document.getElementById("keysState"),
  keysMsg: document.getElementById("keysMsg"),
  googleState: document.getElementById("googleState"),
  googleClientId: document.getElementById("googleClientId"),
  googleClientSecret: document.getElementById("googleClientSecret"),
  saveGoogleKeys: document.getElementById("saveGoogleKeys"),
  connectGoogle: document.getElementById("connectGoogle"),
  disconnectGoogle: document.getElementById("disconnectGoogle"),
  reminderList: document.getElementById("reminderList"),
  refreshReminders: document.getElementById("refreshReminders"),
};
let keysReady = false;
let defaultPromptId = "jarvis";

function showKeyState(cfg) {
  const hints = cfg.keyHints || {};
  els.deepgramKey.placeholder = hints.deepgram ? `Saved ${hints.deepgram} — paste to replace` : "Paste your Deepgram API key";
  els.braveKey.placeholder = hints.brave ? `Saved ${hints.brave} — paste to replace` : "Optional — enables web search";
  els.deepgramKey.classList.toggle("saved", Boolean(hints.deepgram));
  els.braveKey.classList.toggle("saved", Boolean(hints.brave));
  keysReady = Boolean(hints.deepgram);
  els.keysState.textContent = keysReady ? "Ready" : "Deepgram key needed";
  els.keysState.className = `keys-state ${keysReady ? "ok" : "missing"}`;
  els.start.disabled = !keysReady;
}

function showGoogleState(cfg) {
  els.googleState.textContent = cfg.googleConnected ? "Connected" : cfg.googleAppConfigured ? "Not connected" : "Needs client ID/secret";
  els.googleState.classList.toggle("ok", Boolean(cfg.googleConnected));
  els.connectGoogle.disabled = !cfg.googleAppConfigured;
  els.disconnectGoogle.disabled = !cfg.googleConnected;
}

async function saveKeys() {
  const deepgram = els.deepgramKey.value.trim();
  const brave = els.braveKey.value.trim();
  if (!deepgram && !brave) { els.keysMsg.textContent = "Paste at least one key first."; els.keysMsg.className = "keys-msg error"; return; }
  els.saveKeys.disabled = true;
  els.keysMsg.textContent = "Checking with the provider…";
  els.keysMsg.className = "keys-msg";
  try {
    const r = await fetch("/api/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deepgram, brave }) });
    const body = await r.json();
    const problems = ["deepgram", "brave"].filter((k) => body[k] && body[k] !== "ok").map((k) => body[k]);
    els.keysMsg.textContent = problems.length ? problems.join(". ") : "Saved. Keys verified and written to .env.";
    els.keysMsg.className = `keys-msg ${problems.length ? "error" : "ok"}`;
    if (body.deepgram === "ok") els.deepgramKey.value = "";
    if (body.brave === "ok") els.braveKey.value = "";
    showKeyState(body);
    if (body.deepgram === "ok") loadVoices();
  } catch (err) {
    els.keysMsg.textContent = `Could not save: ${err.message}`;
    els.keysMsg.className = "keys-msg error";
  } finally {
    els.saveKeys.disabled = false;
  }
}

async function saveGoogleKeys() {
  const clientId = els.googleClientId.value.trim();
  const clientSecret = els.googleClientSecret.value.trim();
  if (!clientId && !clientSecret) return;
  const r = await fetch("/api/google-app-keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId, clientSecret }) });
  const body = await r.json();
  els.googleClientId.value = "";
  els.googleClientSecret.value = "";
  showGoogleState({ googleAppConfigured: body.hasClientId && body.hasClientSecret, googleConnected: els.googleState.classList.contains("ok") });
}

let voices = [];
let previewAudio = null;

async function loadVoices() {
  try {
    const r = await fetch("/api/voices");
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.statusText);
    voices = body.voices;
    els.voice.innerHTML = "";
    const groups = new Map();
    for (const v of voices) {
      if (!groups.has(v.group)) {
        const optgroup = document.createElement("optgroup");
        optgroup.label = v.group;
        groups.set(v.group, optgroup);
        els.voice.appendChild(optgroup);
      }
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.name;
      groups.get(v.group).appendChild(opt);
    }
    let chosen = body.defaultVoice;
    try { chosen = localStorage.getItem("voice") || chosen; } catch {}
    if (voices.some((v) => v.id === chosen)) els.voice.value = chosen;
    els.preview.hidden = !voices.find((v) => v.id === els.voice.value)?.sample;
  } catch (err) {
    els.voice.innerHTML = `<option value="">Could not load voices: ${err.message}</option>`;
    els.preview.hidden = true;
  }
}

function previewVoice() {
  const v = voices.find((x) => x.id === els.voice.value);
  if (!v?.sample) return;
  if (previewAudio) { previewAudio.pause(); previewAudio = null; els.preview.textContent = "▶"; return; }
  previewAudio = new Audio(v.sample);
  els.preview.textContent = "■";
  previewAudio.onended = previewAudio.onerror = () => { previewAudio = null; els.preview.textContent = "▶"; };
  previewAudio.play().catch(() => { previewAudio = null; els.preview.textContent = "▶"; });
}

function fmtDue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function loadReminders() {
  try {
    const r = await fetch("/api/reminders");
    const body = await r.json();
    els.reminderList.innerHTML = "";
    for (const rem of body.reminders || []) {
      const row = document.createElement("div");
      row.className = "reminder";
      row.innerHTML = `<span>${rem.text}</span><span class="due">${fmtDue(rem.due_at)}</span>`;
      els.reminderList.appendChild(row);
    }
  } catch {}
}

function agentUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = new URL(`${proto}://${location.host}/agent`);
  url.searchParams.set("prompt", defaultPromptId);
  if (els.voice.value) url.searchParams.set("voice", els.voice.value);
  return url.toString();
}

let ws, audioCtx, micStream, workletNode;
let playCtx, nextStartTime = 0, activeSources = [];
let sampleRate = 16000;

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
  els.orb.classList.toggle("live", kind === "live");
}

function addLine(role, text) {
  const row = document.createElement("div");
  row.className = `line ${role}`;
  row.innerHTML = `<span class="who">${role === "user" ? "You" : "Jarvis"}</span><span class="text"></span>`;
  row.querySelector(".text").textContent = text;
  els.transcript.appendChild(row);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

async function loadConfig() {
  const cfg = await fetch("/api/config").then((r) => r.json());
  sampleRate = cfg.sampleRate;
  defaultPromptId = cfg.prompts?.[0]?.id || "jarvis";
  els.meta.textContent = `LLM: ${cfg.thinkModel} (${cfg.thinkVia})`;
  showKeyState(cfg);
  showGoogleState(cfg);
  if (!keysReady) setStatus("Add your Deepgram key to begin", "muted");
  return cfg;
}

// ---- TTS playback: queue raw PCM16 chunks back-to-back on one AudioContext timeline ----
function initPlayback() {
  playCtx = new AudioContext({ sampleRate });
  nextStartTime = 0;
}
function playPCM16(arrayBuffer) {
  if (!playCtx) return;
  const int16 = new Int16Array(arrayBuffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
  const buffer = playCtx.createBuffer(1, float32.length, sampleRate);
  buffer.copyToChannel(float32, 0);
  const src = playCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(playCtx.destination);
  const startAt = Math.max(playCtx.currentTime, nextStartTime);
  src.start(startAt);
  nextStartTime = startAt + buffer.duration;
  activeSources.push(src);
  src.onended = () => { activeSources = activeSources.filter((s) => s !== src); };
}
function stopPlayback() {
  for (const s of activeSources) { try { s.stop(); } catch {} }
  activeSources = [];
  nextStartTime = playCtx ? playCtx.currentTime : 0;
}

function connectAgent() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(agentUrl());
    ws.binaryType = "arraybuffer";
    ws.onopen = () => setStatus("Connected to Deepgram, applying settings…");
    ws.onerror = () => reject(new Error("WebSocket error"));
    ws.onclose = () => setStatus("Disconnected", "muted");
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        playPCM16(ev.data);
        return;
      }
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case "Welcome": break;
        case "SettingsApplied":
          setStatus("Listening — start talking", "live");
          resolve();
          break;
        case "ConversationText":
          addLine(msg.role === "user" ? "user" : "assistant", msg.content);
          break;
        case "UserStartedSpeaking":
          stopPlayback(); // barge-in
          els.orb.classList.remove("speaking");
          setStatus("Listening…", "live");
          break;
        case "AgentThinking":
          setStatus("Thinking…", "live");
          break;
        case "AgentStartedSpeaking":
          els.orb.classList.add("speaking");
          setStatus("Speaking…", "live");
          break;
        case "AgentAudioDone":
          els.orb.classList.remove("speaking");
          setStatus("Listening — start talking", "live");
          break;
        case "Error":
        case "ProxyClosed":
          setStatus(msg.error || msg.description || `Connection closed (${msg.code}) ${msg.reason || ""}`, "error");
          if (msg.type === "Error") reject(new Error(msg.error || msg.description));
          break;
        default:
          break;
      }
    };
  });
}

async function requestMicPermission() {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch (err) {
    setStatus(`Microphone blocked: ${err.message}. Click the camera/mic icon in the address bar to allow it.`, "error");
    return false;
  }
  await listMics();
  return true;
}

async function listMics() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter((d) => d.kind === "audioinput");
  const previous = els.mic.value;
  els.mic.innerHTML = "";
  if (mics.length === 0) {
    els.mic.innerHTML = '<option value="">No microphone found</option>';
    return;
  }
  for (const [i, d] of mics.entries()) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone ${i + 1}`;
    els.mic.appendChild(opt);
  }
  if (previous && mics.some((d) => d.deviceId === previous)) els.mic.value = previous;
  els.micPerm.hidden = mics.every((d) => d.label);
}

function showLevel(int16Buffer) {
  const samples = new Int16Array(int16Buffer);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length) / 32768;
  els.levelBar.style.width = `${Math.min(100, rms * 400)}%`;
}

async function startMic() {
  const deviceId = els.mic.value;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    },
  });
  await listMics();
  audioCtx = new AudioContext({ sampleRate });
  await audioCtx.audioWorklet.addModule("/mic-worklet.js");
  const source = audioCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(audioCtx, "pcm-capture");
  workletNode.port.onmessage = (ev) => {
    showLevel(ev.data);
    if (ws?.readyState === WebSocket.OPEN) ws.send(ev.data);
  };
  source.connect(workletNode);
}

async function start() {
  els.start.disabled = true;
  els.transcript.innerHTML = "";
  try {
    setStatus("Connecting to Deepgram…");
    initPlayback();
    await connectAgent();
    await startMic();
    els.stop.disabled = false;
  } catch (err) {
    console.error(err);
    setStatus(err.message, "error");
    await stop();
  }
}

async function stop() {
  els.stop.disabled = true;
  try { ws?.close(); } catch {}
  try { workletNode?.disconnect(); } catch {}
  try { micStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { await audioCtx?.close(); } catch {}
  stopPlayback();
  try { await playCtx?.close(); } catch {}
  ws = workletNode = micStream = audioCtx = playCtx = null;
  els.orb.classList.remove("speaking", "live");
  els.levelBar.style.width = "0";
  els.start.disabled = !keysReady;
  setStatus("Stopped", "muted");
  loadReminders();
}

els.mic.onchange = async () => {
  if (!micStream) return;
  try {
    workletNode?.disconnect();
    micStream.getTracks().forEach((t) => t.stop());
    await audioCtx?.close();
    await startMic();
  } catch (err) {
    setStatus(`Could not switch microphone: ${err.message}`, "error");
  }
};
els.saveKeys.onclick = saveKeys;
for (const input of [els.deepgramKey, els.braveKey]) input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") saveKeys(); });
els.voice.onchange = () => {
  try { localStorage.setItem("voice", els.voice.value); } catch {}
  if (previewAudio) { previewAudio.pause(); previewAudio = null; els.preview.textContent = "▶"; }
  els.preview.hidden = !voices.find((v) => v.id === els.voice.value)?.sample;
};
els.preview.onclick = previewVoice;
els.saveGoogleKeys.onclick = saveGoogleKeys;
els.connectGoogle.onclick = () => { window.open("/auth/google", "_blank", "noopener"); };
els.disconnectGoogle.onclick = async () => {
  await fetch("/api/google-disconnect", { method: "POST" });
  loadConfig();
};
els.refreshReminders.onclick = loadReminders;
els.micPerm.onclick = requestMicPermission;
els.start.onclick = start;
els.stop.onclick = stop;
navigator.mediaDevices.addEventListener("devicechange", listMics);
loadVoices();
loadConfig().then(requestMicPermission);
loadReminders();
