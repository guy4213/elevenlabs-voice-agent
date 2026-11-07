// Creates (or updates, if one already exists) the voice agent in ElevenLabs via the API.
// Run with: npm run agent
// The agent ID is saved to .env automatically.

import { readFileSync, writeFileSync } from "node:fs";

const API = "https://api.elevenlabs.io/v1/convai";
const apiKey = process.env.ELEVENLABS_API_KEY;
const existingId = process.env.ELEVENLABS_AGENT_ID?.trim();

if (!apiKey) {
  console.error("ELEVENLABS_API_KEY is missing from .env");
  process.exit(1);
}

// ===== Agent settings: edit here and rerun npm run agent =====
const agent = {
  name: "Demo Voice Agent",
  tags: ["demo"],
  // Only a server holding the API key can open a conversation (the agent ID alone isn't enough)
  platform_settings: { auth: { enable_auth: true } },
  conversation_config: {
    agent: {
      language: "he",
      first_message: "היי! אני העוזר הקולי שלך. על מה בא לך לדבר?",
      prompt: {
        prompt: [
          "אתה עוזר קולי ידידותי ונחמד שמדבר עברית.",
          "ענה תמיד בקצרה, במשפט עד שלושה משפטים, כי זו שיחה קולית.",
          "דבר בשפה טבעית ויומיומית, בלי רשימות, כוכביות, סוגריים מרובעים או סימני עיצוב.",
          "אם לא הבנת משהו, בקש בנימוס שיחזרו על זה.",
        ].join("\n"),
        llm: "gemini-2.5-flash",
        temperature: 0.5,
      },
    },
    tts: {
      model_id: "eleven_v4_turbo",
      voice_id: "cjVigY5qzO86Huf0OWal",
      // Off: in Hebrew it inserts tags like [word] into the response
      expressive_mode: false,
    },
    turn: {
      // "normal": replies when you finish a sentence. "eager" cut people off on a short pause ("אני רוצה-")
      turn_eagerness: "normal",
      // Starts generating a reply before the turn is confirmed, which lowers latency
      speculative_turn: true,
      turn_timeout: 7,
    },
  },
};
// ============================================================

const url = existingId ? `${API}/agents/${existingId}` : `${API}/agents/create`;
const res = await fetch(url, {
  method: existingId ? "PATCH" : "POST",
  headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
  body: JSON.stringify(agent),
});

const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Error ${res.status}:`, JSON.stringify(body, null, 2));
  process.exit(1);
}

const agentId = existingId || body.agent_id;

if (!existingId) {
  const env = readFileSync(".env", "utf8");
  const updated = /^ELEVENLABS_AGENT_ID=.*$/m.test(env)
    ? env.replace(/^ELEVENLABS_AGENT_ID=.*$/m, `ELEVENLABS_AGENT_ID=${agentId}`)
    : `${env.trimEnd()}\nELEVENLABS_AGENT_ID=${agentId}\n`;
  writeFileSync(".env", updated);
}

console.log(`${existingId ? "Agent updated" : "Agent created"}: ${agentId}`);
console.log(`In the ElevenLabs UI: https://elevenlabs.io/app/agents/agents/${agentId}`);
