// A small local server with no dependencies:
// 1. Serves the dashboard (public/)
// 2. Issues a short-lived signed URL per conversation, so the API key never reaches the browser
// Run with: npm start

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const API = "https://api.elevenlabs.io/v1/convai";
const apiKey = process.env.ELEVENLABS_API_KEY;
const agentId = process.env.ELEVENLABS_AGENT_ID?.trim();
const port = Number(process.env.PORT) || 3000;

if (!apiKey || !agentId) {
  console.error("ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID is missing from .env. Run npm run agent first.");
  process.exit(1);
}

const PUBLIC_DIR = join(import.meta.dirname, "public");
const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString("en-GB");

// "fetch failed" hides the real cause (DNS, ECONNRESET, timeout...) inside err.cause
function networkCause(err) {
  const c = err?.cause;
  if (!c) return err?.name === "TimeoutError" ? "timeout" : err?.message;
  if (c.errors?.length) return c.errors.map((e) => `${e.code ?? e.name} ${e.address ?? ""}`.trim()).join(", ");
  return [c.code, c.message].filter(Boolean).join(" ");
}

function errorText(body, status) {
  const detail = body?.detail;
  if (status === 429 && detail?.code === "concurrent_limit_exceeded") {
    return "הגעת למגבלת השיחות במקביל בחשבון. חכה דקה-שתיים ונסה שוב.";
  }
  if (status === 429) return "יותר מדי בקשות ל-ElevenLabs. חכה רגע ונסה שוב.";
  if (status === 401) return "מפתח ה-API לא תקין. בדוק את ELEVENLABS_API_KEY ב-.env.";
  if (typeof detail === "string") return detail;
  if (detail?.message) return detail.message;
  return `ElevenLabs returned ${status}`;
}

async function elevenlabs(path, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        headers: { "xi-api-key": apiKey },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      const cause = networkCause(err);
      console.error(`[${now()}] network error ${path.split("?")[0]} (attempt ${attempt}/${attempts}): ${cause}`);
      if (attempt < attempts) {
        await sleep(400 * attempt);
        continue;
      }
      throw Object.assign(new Error(`אין חיבור ל-ElevenLabs (${cause}). בדוק חיבור לאינטרנט.`), { status: 502 });
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[${now()}] ElevenLabs ${res.status} ${path.split("?")[0]}: ${JSON.stringify(body?.detail ?? body)}`);
      throw Object.assign(new Error(errorText(body, res.status)), { status: res.status });
    }
    return body;
  }
}

createServer(async (req, res) => {
  // Not new URL(): it throws on addresses like "//" and would crash the whole server
  const pathname = (req.url ?? "/").split("?")[0].replace(/\/{2,}/g, "/");

  try {
    // Signed URL for a new conversation (WebSocket). Unlike a WebRTC token, it only
    // takes a concurrency slot once actually connected, so an abandoned attempt doesn't block the account.
    if (pathname === "/api/signed-url") {
      const { signed_url } = await elevenlabs(`/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
      console.log(`[${now()}] signed URL issued for a conversation`);
      return sendJson(res, 200, { signedUrl: signed_url });
    }

    // Agent settings to display in the dashboard (no secrets)
    if (pathname === "/api/agent") {
      const a = await elevenlabs(`/agents/${encodeURIComponent(agentId)}`);
      const c = a.conversation_config ?? {};
      return sendJson(res, 200, {
        id: a.agent_id,
        name: a.name,
        language: c.agent?.language,
        llm: c.agent?.prompt?.llm,
        prompt: c.agent?.prompt?.prompt,
        firstMessage: c.agent?.first_message,
        ttsModel: c.tts?.model_id,
        turnEagerness: c.turn?.turn_eagerness,
      });
    }

    const file = STATIC_FILES[pathname];
    if (file) {
      const [name, type] = file;
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      return res.end(await readFile(join(PUBLIC_DIR, name)));
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (err) {
    sendJson(res, err.status && err.status < 600 ? err.status : 502, { error: err.message });
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Dashboard is running: http://localhost:${port}`);
});
