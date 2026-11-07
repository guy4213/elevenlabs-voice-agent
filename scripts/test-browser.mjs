// npm run test:browser: tests the dashboard itself in a real browser (headless Chrome/Edge).
// The microphone is fake: Chrome "says" the question from a recording file, exactly as if you were talking.
// Checks: the page loads, the conversation connects, the question shows up in the transcript, the agent answers, and the conversation ends.
// Requires npm start running, and npm test run at least once (it creates the recording).
// Uses a separate temporary Chrome profile and doesn't touch your regular browser.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = `http://localhost:${process.env.PORT || 3000}`;
const EXPECT_IN_TRANSCRIPT = "צרפת";
const pcmPath = new URL("../.cache/question-he.pcm", import.meta.url);

const BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];

// The dashboard's state, read from the page itself
const SNAPSHOT = `JSON.stringify({
  status: document.body.dataset.status,
  error: document.getElementById("error").hidden ? "" : document.getElementById("error").textContent,
  last: document.getElementById("statLast").textContent,
  mics: [...document.querySelectorAll("#micSelect option")].map((o) => o.textContent),
  msgs: [...document.querySelectorAll("#log .msg")].map((m) => ({
    who: m.classList.contains("user") ? "user" : "agent",
    text: m.querySelector(".bubble").textContent,
  })),
})`;

let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(ok, label, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  (${detail})` : ""}`);
  return ok;
}

const browserPath = BROWSERS.find(existsSync);
if (!browserPath) {
  console.error("Chrome or Edge not found");
  process.exit(1);
}
if (!existsSync(pcmPath)) {
  console.error("No recording yet. Run npm test once first.");
  process.exit(1);
}

// Fake microphone: 7s of silence (while the greeting plays) -> the question -> 12s of silence
const profileDir = mkdtempSync(join(tmpdir(), "voice-demo-chrome-"));
const pcm = readFileSync(pcmPath);
const audio = Buffer.concat([Buffer.alloc(32000 * 7), pcm, Buffer.alloc(32000 * 12)]);
const wavPath = join(profileDir, "mic.wav");
writeFileSync(wavPath, wav(audio));

const browser = spawn(
  browserPath,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wavPath}`,
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" }
);

const consoleErrors = [];
let ws;
let nextId = 0;
const pending = new Map();

try {
  console.log(`\nBrowser: ${browserPath.split("/").pop()}`);

  // Chrome writes the debugging port to DevToolsActivePort
  let port;
  for (let i = 0; i < 50 && !port; i++) {
    await sleep(200);
    try {
      port = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0];
    } catch {}
  }
  if (!check(!!port, "The browser started")) throw new Error("browser did not start");

  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = targets.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      consoleErrors.push(d.exception?.description ?? d.text);
    }
  };

  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Page.navigate", { url: BASE });

  // Waiting for the page and the ElevenLabs library to load
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(250);
    ready = await evaluate(`document.readyState === "complete" && !!window.ElevenLabsClient?.Conversation`).catch(() => false);
  }
  check(ready, "The page loaded together with the ElevenLabs library");

  await sleep(1000);
  const info = await evaluate(`document.querySelectorAll("#agentInfo dt").length`);
  check(info > 1, "Agent settings displayed", `${info} fields`);

  console.log("\nConversation (fake microphone)");
  await evaluate(`document.getElementById("toggleBtn").click()`);

  let state;
  let connectedAt = 0;
  const statuses = [];
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    state = JSON.parse(await evaluate(SNAPSHOT));
    if (statuses.at(-1) !== state.status) statuses.push(state.status);
    if (state.status === "connected" && !connectedAt) connectedAt = Date.now();
    if (state.error) break;
    const qi = state.msgs.findIndex((m) => m.who === "user" && m.text.includes(EXPECT_IN_TRANSCRIPT));
    if (qi >= 0 && state.msgs.slice(qi + 1).some((m) => m.who === "agent")) break;
  }

  check(!state.error, "No error on screen", state.error);
  check(!!connectedAt, "The conversation connected", statuses.join(" → "));
  const greeting = state.msgs.find((m) => m.who === "agent");
  check(!!greeting, "The opening message appeared in the transcript", greeting?.text);
  const qi = state.msgs.findIndex((m) => m.who === "user" && m.text.includes(EXPECT_IN_TRANSCRIPT));
  const userTexts = state.msgs.filter((m) => m.who === "user").map((m) => m.text).join(" | ");
  check(qi >= 0, "Your question appeared in the transcript", qi >= 0 ? state.msgs[qi].text : userTexts || "nothing was heard");
  const answer = qi >= 0 ? state.msgs.slice(qi + 1).find((m) => m.who === "agent") : null;
  check(!!answer, "The agent's answer appeared in the transcript", answer?.text);
  const latency = parseFloat(state.last);
  check(latency > 0.2 && latency < 5, "A realistic response time is shown in the dashboard", state.last);
  check(state.mics.length > 0, "Microphone list loaded", `${state.mics.length} options`);

  // Ending the conversation
  await evaluate(`document.getElementById("toggleBtn").click()`);
  let ended = false;
  for (let i = 0; i < 20 && !ended; i++) {
    await sleep(250);
    ended = (await evaluate(`document.body.dataset.status`)) === "disconnected";
  }
  check(ended, "The conversation ended when End was clicked");

  check(consoleErrors.length === 0, "No errors in the browser console", consoleErrors.slice(0, 3).join(" | "));
} catch (err) {
  check(false, "Browser test", err.message);
} finally {
  try {
    await cdp("Browser.close");
  } catch {}
  await sleep(800);
  browser.kill();
  await sleep(300);
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {}
}

console.log(failures ? `\n✗ ${failures} tests failed\n` : "\n✓ All browser tests passed\n");
process.exit(failures ? 1 : 0);

// ---------- helpers ----------

function cdp(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
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
