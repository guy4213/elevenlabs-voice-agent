// npm test: checks the local server, then runs a real voice conversation with the agent.
// It generates a spoken question in Hebrew, streams it to the agent as if from a microphone,
// and checks that the agent transcribed it, understood it, and answered in a voice.
// Requires npm start to be running in another terminal. Each run is one short conversation (uses some credits).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const BASE = `http://localhost:${process.env.PORT || 3000}`;
const apiKey = process.env.ELEVENLABS_API_KEY;
const QUESTION = "מה עיר הבירה של צרפת?";
const EXPECT_IN_TRANSCRIPT = "צרפת";
const EXPECT_IN_ANSWER = "פריז";
const MAX_LATENCY_MS = 3000;
const CHUNK_BYTES = 3200; // 100ms of PCM 16kHz 16-bit mono

let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(ok, label, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  (${detail})` : ""}`);
  return ok;
}

// ---------- 1. Local server ----------
console.log("\n1. Local server");
for (const path of ["/", "/app.js", "/styles.css"]) {
  try {
    const r = await fetch(BASE + path);
    check(r.ok, `GET ${path}`, String(r.status));
  } catch {
    check(false, `GET ${path}`, `the server isn't running at ${BASE}. Run npm start`);
    process.exit(1);
  }
}
{
  const r = await fetch(`${BASE}/api/agent`);
  const a = await r.json();
  check(r.ok && a.id, "GET /api/agent", r.ok ? `${a.name} · ${a.language} · ${a.turnEagerness}` : a.error);
}

// ---------- 2. Signed URL several times in a row ----------
console.log("\n2. Opening a conversation (5 times in a row)");
let signedUrl;
for (let i = 1; i <= 5; i++) {
  const t = Date.now();
  const r = await fetch(`${BASE}/api/signed-url`);
  const d = await r.json();
  check(r.ok && d.signedUrl, `GET /api/signed-url #${i}`, r.ok ? `${Date.now() - t}ms` : d.error);
  signedUrl ??= d.signedUrl;
}
if (!signedUrl) process.exit(1);

// ---------- 3. Spoken question ----------
console.log("\n3. Spoken question");
const cacheDir = new URL("../.cache/", import.meta.url);
const pcmFile = new URL("question-he.pcm", cacheDir);
let pcm;
if (existsSync(pcmFile)) {
  pcm = readFileSync(pcmFile);
  check(true, "Recording loaded from cache", `${(pcm.length / 32000).toFixed(1)}s`);
} else {
  const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/cjVigY5qzO86Huf0OWal?output_format=pcm_16000", {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    // v4 speaks Hebrew clearly (multilingual_v2 produced unintelligible Hebrew)
    body: JSON.stringify({ text: QUESTION, model_id: "eleven_v4_turbo" }),
  });
  if (!check(r.ok, "Generate a recording of the question", r.ok ? "" : await r.text())) process.exit(1);
  pcm = Buffer.from(await r.arrayBuffer());

  // Make sure the recording itself is clear (otherwise the test would test the recording, not the agent)
  const form = new FormData();
  form.append("model_id", "scribe_v2");
  form.append("language_code", "he");
  form.append("file", new Blob([wav(pcm)], { type: "audio/wav" }), "question.wav");
  const stt = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  }).then((x) => x.json());
  if (!check(stt.text?.includes(EXPECT_IN_TRANSCRIPT), "The recording is clear (accurate transcription)", stt.text)) process.exit(1);

  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(pcmFile, pcm);
}

function wav(data) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// Trim trailing silence, so latency is measured from the actual end of speech
const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
let end = samples.length;
while (end > 0 && Math.abs(samples[end - 1]) < 400) end--;
const speech = pcm.subarray(0, end * 2);

// ---------- 4. Voice conversation ----------
console.log("\n4. Voice conversation with the agent");
const result = await new Promise((resolve) => {
  const ws = new WebSocket(signedUrl);
  const r = { greeting: "", transcript: "", answer: "", answerAudioChunks: 0, latency: null, error: "" };
  const silence = Buffer.alloc(CHUNK_BYTES);
  let queue = [];
  let phase = "greeting"; // greeting -> speaking -> waiting -> done
  let speechEndAt = 0;
  let greetingAudioBytes = 0;

  const finish = () => {
    if (phase === "done") return;
    phase = "done";
    clearInterval(pump);
    clearTimeout(timeout);
    ws.close();
    resolve(r);
  };
  const timeout = setTimeout(() => {
    r.error = "timeout: no complete answer within 30 seconds";
    finish();
  }, 30_000);

  // Like a real microphone: every 100ms sends an audio chunk (speech, or silence)
  const pump = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const chunk = queue.shift() ?? silence;
    ws.send(JSON.stringify({ user_audio_chunk: chunk.toString("base64") }));
    if (phase === "speaking" && queue.length === 0) {
      phase = "waiting";
      speechEndAt = Date.now();
    }
  }, 100);

  ws.onopen = () => ws.send(JSON.stringify({ type: "conversation_initiation_client_data" }));
  ws.onerror = () => {
    r.error = "WebSocket error";
    finish();
  };
  ws.onclose = (e) => {
    if (phase !== "done") {
      r.error = `the connection closed early (${e.code} ${e.reason})`;
      finish();
    }
  };

  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case "ping":
        ws.send(JSON.stringify({ type: "pong", event_id: m.ping_event.event_id }));
        break;
      case "audio":
        if (phase === "greeting") greetingAudioBytes += Buffer.from(m.audio_event.audio_base_64, "base64").length;
        if (phase === "waiting") {
          r.answerAudioChunks++;
          r.latency ??= Date.now() - speechEndAt;
        }
        break;
      case "user_transcript":
        r.transcript = m.user_transcription_event.user_transcript;
        break;
      case "agent_response":
        if (phase === "greeting") {
          r.greeting = m.agent_response_event.agent_response;
          // Wait for the greeting to "finish playing", then speak
          await sleep(1200);
          await sleep(Math.max(0, (greetingAudioBytes / 32000) * 1000 - 1200) + 500);
          for (let i = 0; i < speech.length; i += CHUNK_BYTES) queue.push(speech.subarray(i, i + CHUNK_BYTES));
          phase = "speaking";
        } else if (phase === "waiting") {
          r.answer = m.agent_response_event.agent_response;
          setTimeout(finish, 1500);
        }
        break;
      case "error":
        r.error = JSON.stringify(m);
        break;
    }
  };
});

check(!result.error, "The conversation completed without errors", result.error);
check(!!result.greeting, "Opening message", result.greeting);
check(result.transcript.includes(EXPECT_IN_TRANSCRIPT), "The agent heard and transcribed the question", result.transcript || "empty transcript");
check(result.answer.includes(EXPECT_IN_ANSWER), "The agent answered correctly", result.answer || "no answer");
check(result.answerAudioChunks > 0, "The answer arrived with audio", `${result.answerAudioChunks} chunks`);
check(
  result.latency !== null && result.latency < MAX_LATENCY_MS,
  `Response time from end of speech < ${MAX_LATENCY_MS / 1000}s`,
  result.latency === null ? "no audio" : `${(result.latency / 1000).toFixed(2)}s`
);

console.log(failures ? `\n✗ ${failures} tests failed\n` : "\n✓ All tests passed\n");
process.exit(failures ? 1 : 0);
