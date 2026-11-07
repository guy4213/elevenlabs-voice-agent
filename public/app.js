// Dashboard: a live voice conversation with an ElevenLabs agent.
// Turn-taking happens on the ElevenLabs side, so the agent replies as soon as you stop talking.

const Conversation = window.ElevenLabsClient?.Conversation;
const $ = (id) => document.getElementById(id);

const els = {
  orb: $("orb"),
  toggle: $("toggleBtn"),
  mute: $("muteBtn"),
  hint: $("hint"),
  statusText: $("statusText"),
  error: $("error"),
  log: $("log"),
  msgCount: $("msgCount"),
  inMeter: $("inMeter"),
  outMeter: $("outMeter"),
  statMode: $("statMode"),
  statLast: $("statLast"),
  statAvg: $("statAvg"),
  statDuration: $("statDuration"),
  agentName: $("agentName"),
  agentInfo: $("agentInfo"),
  mic: $("micSelect"),
};

const STATUS_TEXT = {
  disconnected: "לא מחובר",
  connecting: "מתחבר…",
  connected: "מחובר",
  disconnecting: "מתנתק…",
};

const LANGUAGES = { he: "עברית", en: "אנגלית", ar: "ערבית", ru: "רוסית" };

let conversation = null;
let status = "disconnected";
let mode = null;
let muted = false;
let startedAt = 0;
let clockTimer = 0;
let meterTimer = 0;
let lastSpeechAt = 0; // last time the microphone picked up speech (for response time)
let listeningSince = 0; // when your turn started
let lastVoiceAt = 0; // last time the microphone picked up any audio (for the silent-mic warning)
let micWarning = false;
let latencies = [];
let messageCount = 0;

// ---------- UI ----------

function setStatus(next) {
  status = next;
  document.body.dataset.status = next;
  els.statusText.textContent = STATUS_TEXT[next] ?? next;

  const live = next === "connected";
  const busy = next === "connecting" || next === "disconnecting";
  els.toggle.textContent = live || next === "disconnecting" ? "סיים שיחה" : "התחל שיחה";
  els.toggle.classList.toggle("danger", live);
  els.toggle.classList.toggle("primary", !live);
  els.toggle.disabled = busy;
  els.orb.disabled = busy;
  els.mute.disabled = !live;
  els.mic.disabled = next !== "disconnected";

  if (next === "connecting") els.hint.textContent = "מתחבר לסוכן…";
  if (next === "disconnected") {
    setMode(null);
    els.hint.textContent = "לחץ על העיגול כדי להתחיל לדבר";
  }
}

function setMode(next) {
  mode = next;
  document.body.dataset.mode = next ?? "";
  if (!next) {
    els.statMode.textContent = "—";
    return;
  }
  const speaking = next === "speaking";
  if (!speaking) {
    listeningSince = Date.now();
    lastVoiceAt = Date.now(); // the silence timer starts when it's your turn
  }
  els.statMode.textContent = speaking ? "הסוכן מדבר" : "מקשיב לך";
  updateHint();

  // Response time = from when you stopped talking until the agent starts talking
  if (speaking && lastSpeechAt > listeningSince) {
    latencies.push(Date.now() - lastSpeechAt);
    lastSpeechAt = 0;
    renderLatency();
  }
}

function updateHint() {
  if (status !== "connected" || micWarning) return;
  if (mode === "speaking") els.hint.textContent = "הסוכן עונה… אפשר לקטוע אותו בכל רגע";
  else if (muted) els.hint.textContent = "המיקרופון מושתק";
  else els.hint.textContent = "דבר עכשיו. הסוכן יענה כשתסיים";
}

const fmtSeconds = (ms) => `${(ms / 1000).toFixed(2)} שנ׳`;

function renderLatency() {
  if (!latencies.length) {
    els.statLast.textContent = "—";
    els.statAvg.textContent = "—";
    return;
  }
  const last = latencies[latencies.length - 1];
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  els.statLast.textContent = fmtSeconds(last);
  els.statAvg.textContent = fmtSeconds(avg);
}

function renderClock() {
  const sec = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  els.statDuration.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function addMessage(source, text) {
  if (!text?.trim()) return;
  els.log.querySelector(".empty")?.remove();

  const item = document.createElement("div");
  item.className = `msg ${source === "user" ? "user" : "agent"}`;

  const meta = document.createElement("span");
  meta.className = "meta";
  const time = new Date().toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  meta.textContent = `${source === "user" ? "אתה" : "הסוכן"} · ${time}`;

  const bubble = document.createElement("p");
  bubble.className = "bubble";
  bubble.dir = "auto";
  bubble.textContent = text;

  item.append(meta, bubble);
  els.log.append(item);
  els.log.scrollTop = els.log.scrollHeight;

  messageCount += 1;
  els.msgCount.textContent = `${messageCount} הודעות`;
}

function addSystemNote(text) {
  const note = document.createElement("p");
  note.className = "system-note";
  note.textContent = text;
  els.log.append(note);
  els.log.scrollTop = els.log.scrollHeight;
}

function showError(text) {
  els.error.textContent = text;
  els.error.hidden = false;
}

function hideError() {
  els.error.hidden = true;
  els.error.textContent = "";
}

// Every 50ms (not requestAnimationFrame, which stops when the tab is in the background)
function meterTick() {
  if (!conversation) return;
  let input = 0;
  let output = 0;
  try {
    input = muted ? 0 : conversation.getInputVolume();
    output = conversation.getOutputVolume();
  } catch {
    // Audio not ready yet
  }
  const level = mode === "speaking" ? output : input;
  els.orb.style.setProperty("--level", Math.min(1, level * 1.8).toFixed(3));

  // If no audio comes from the microphone for a while, it's probably the wrong mic or a muted one
  if (input > 0.02) lastVoiceAt = Date.now();
  if (input > 0.04 && mode !== "speaking") lastSpeechAt = Date.now();
  const silentMic = status === "connected" && mode === "listening" && !muted && Date.now() - lastVoiceAt > 8000;
  if (silentMic !== micWarning) {
    micWarning = silentMic;
    if (silentMic) els.hint.textContent = "לא מגיע קול מהמיקרופון. בדוק שבחרת את המיקרופון הנכון ושהוא לא מושתק";
    else updateHint();
  }
  els.inMeter.style.width = `${Math.min(100, input * 180)}%`;
  els.outMeter.style.width = `${Math.min(100, output * 180)}%`;
}

function resetSession() {
  latencies = [];
  lastSpeechAt = 0;
  listeningSince = 0;
  messageCount = 0;
  els.msgCount.textContent = "0 הודעות";
  renderLatency();
  startedAt = 0;
  renderClock();
  if (els.log.querySelector(".msg, .system-note")) addSystemNote("שיחה חדשה");
}

function cleanup() {
  conversation = null;
  micWarning = false;
  clearInterval(clockTimer);
  clearInterval(meterTimer);
  els.orb.style.setProperty("--level", "0");
  els.inMeter.style.width = "0%";
  els.outMeter.style.width = "0%";
  muted = false;
  els.mute.textContent = "השתק מיקרופון";
  els.mute.classList.remove("active");
  setStatus("disconnected");
}

// ---------- Conversation ----------

async function startConversation() {
  if (conversation || status !== "disconnected") return;
  if (!Conversation) {
    showError("ספריית ElevenLabs לא נטענה. בדוק את החיבור לאינטרנט ורענן את הדף.");
    return;
  }
  hideError();
  setStatus("connecting");

  // Ask for microphone permission up front, for a clear error message
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    await loadMicrophones();
  } catch {
    setStatus("disconnected");
    showError("אין גישה למיקרופון. אשר הרשאת מיקרופון בדפדפן ונסה שוב.");
    return;
  }

  try {
    let res;
    try {
      res = await fetch("/api/signed-url");
    } catch {
      throw new Error("השרת המקומי לא זמין. ודא ש-npm start רץ.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.signedUrl) throw new Error(data.error || `השרת החזיר ${res.status}`);

    resetSession();

    conversation = await Conversation.startSession({
      signedUrl: data.signedUrl,
      connectionType: "websocket",
      inputDeviceId: els.mic.value || undefined,
      onStatusChange: ({ status: s }) => setStatus(s),
      onModeChange: ({ mode: m }) => setMode(m),
      onMessage: ({ source, message }) => addMessage(source, message),
      onDisconnect: (details) => {
        cleanup();
        if (details?.reason === "error") showError(`השיחה נותקה: ${details.message || "שגיאה"}`);
        addSystemNote(details?.reason === "agent" ? "הסוכן סיים את השיחה" : "השיחה הסתיימה");
      },
      onError: (message) => showError(typeof message === "string" ? message : "אירעה שגיאה בשיחה"),
    });

    startedAt = Date.now();
    lastVoiceAt = Date.now();
    clockTimer = setInterval(renderClock, 1000);
    meterTimer = setInterval(meterTick, 50);
  } catch (err) {
    cleanup();
    showError(`לא הצלחתי להתחבר לסוכן: ${err.message}`);
  }
}

async function endConversation() {
  if (!conversation) return;
  setStatus("disconnecting");
  try {
    await conversation.endSession();
  } catch {
    cleanup();
  }
}

function toggleConversation() {
  if (status === "disconnected") startConversation();
  else if (status === "connected") endConversation();
}

function toggleMute() {
  if (!conversation) return;
  muted = !muted;
  conversation.setMicMuted(muted);
  els.mute.textContent = muted ? "בטל השתקה" : "השתק מיקרופון";
  els.mute.classList.toggle("active", muted);
  updateHint();
}

// ---------- Microphones ----------

const MIC_KEY = "voice-demo-mic";

async function loadMicrophones() {
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  } catch {
    return;
  }
  let saved = "";
  try {
    saved = localStorage.getItem(MIC_KEY) || "";
  } catch {}
  const current = els.mic.value || saved;

  const options = [new Option("ברירת המחדל של המערכת", "")];
  devices
    .filter((d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
    .forEach((d, i) => options.push(new Option(d.label || `מיקרופון ${i + 1}`, d.deviceId)));
  els.mic.replaceChildren(...options);
  if (options.some((o) => o.value === current)) els.mic.value = current;
}

els.mic.addEventListener("change", () => {
  try {
    localStorage.setItem(MIC_KEY, els.mic.value);
  } catch {}
});
navigator.mediaDevices?.addEventListener?.("devicechange", loadMicrophones);

// ---------- Agent settings ----------

async function loadAgentInfo() {
  try {
    const res = await fetch("/api/agent");
    const a = await res.json();
    if (!res.ok) throw new Error(a.error);

    if (a.name) {
      els.agentName.textContent = a.name;
      document.title = `${a.name} · דמו`;
    }

    const rows = [
      ["שפה", LANGUAGES[a.language] ?? a.language],
      ["מודל שפה", a.llm],
      ["מודל קול", a.ttsModel],
      ["מהירות תגובה", a.turnEagerness === "eager" ? "מהירה (eager)" : a.turnEagerness],
      ["הודעת פתיחה", a.firstMessage],
      ["פרומפט", a.prompt],
    ];
    els.agentInfo.replaceChildren(
      ...rows
        .filter(([, v]) => v)
        .map(([k, v]) => {
          const row = document.createElement("div");
          const dt = document.createElement("dt");
          const dd = document.createElement("dd");
          dt.textContent = k;
          dd.textContent = v;
          dd.dir = "auto";
          if (k === "פרומפט") dd.className = "prompt";
          row.append(dt, dd);
          return row;
        })
    );
  } catch (err) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = `לא הצלחתי לטעון את הגדרות הסוכן: ${err.message}`;
    row.append(dt);
    els.agentInfo.replaceChildren(row);
  }
}

els.orb.addEventListener("click", toggleConversation);
els.toggle.addEventListener("click", toggleConversation);
els.mute.addEventListener("click", toggleMute);
window.addEventListener("beforeunload", () => conversation?.endSession());

setStatus("disconnected");
loadAgentInfo();
loadMicrophones();
