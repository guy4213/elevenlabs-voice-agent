# העתקת הסוכן הקולי לפרויקט אחר

המדריך מסביר איך מוסיפים לפרויקט קיים סוכן קולי של ElevenLabs שמתמלל ומדבר בעברית.
כל מה שכאן נבדק בריפו הזה, כולל `npm test` ו-`npm run test:browser`.

## איך זה בנוי

```
דפדפן ──(1) GET /api/elevenlabs/signed-url──▶ השרת שלך ──(2) xi-api-key──▶ ElevenLabs
  │                                                                          │
  └───────────────(3) WebSocket: אודיו מהמיקרופון ⇄ תמלול + תשובה קולית ─────┘
```

- **ElevenLabs** עושים את כל העבודה הקולית: תמלול (Scribe Realtime), זיהוי סוף דיבור, מודל השפה (Gemini) ויצירת הקול.
- **השרת שלך** מחזיק את מפתח ה-API ומנפיק קישור חתום לכל שיחה. המפתח לא מגיע לדפדפן.
- **הדפדפן** פותח את השיחה עם `@elevenlabs/client` (או `@elevenlabs/react`) ומקבל אירועים: תמלול, תשובות, מצב (מדבר/מקשיב).

## 1. הסוכן

אפשר להשתמש בסוכן הקיים: מעתיקים את `ELEVENLABS_AGENT_ID` מה-`.env` של הריפו הזה.

אפשר גם ליצור סוכן חדש. מעתיקים את [scripts/create-agent.mjs](scripts/create-agent.mjs), עורכים בו את הפרומפט, ומריצים:

```bash
node --env-file=.env scripts/create-agent.mjs   # יוצר סוכן ושומר את ה-ID ב-.env. בהרצה חוזרת הוא מעדכן את הסוכן
```

משתני סביבה לשרת (לא בקוד ולא בגיט):

```bash
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_AGENT_ID=agent_...
```

## 2. השרת: endpoint אחד

Express:

```js
app.get("/api/elevenlabs/signed-url", requireLogin, async (req, res) => {
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${process.env.ELEVENLABS_AGENT_ID}`;
  try {
    const r = await fetch(url, { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } });
    const body = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: body?.detail?.message ?? "ElevenLabs error" });
    res.json({ signedUrl: body.signed_url });
  } catch (err) {
    res.status(502).json({ error: `ElevenLabs unreachable: ${err.cause?.code ?? err.message}` });
  }
});
```

- **`requireLogin`:** ה-middleware של האימות בפרויקט שלך. בלי אימות, כל מי שמגיע ל-endpoint יכול לפתוח שיחות על חשבונך ולבזבז קרדיטים.
- **גרסה מלאה בלי Express:** ב-[server.mjs](server.mjs), כולל ניסיון חוזר בשגיאות רשת והודעות שגיאה בעברית.

## 3. הדפדפן

### React

```bash
npm install @elevenlabs/react@1.19.1
```

```tsx
import { useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";

type Line = { source: "user" | "ai"; text: string };

export function VoiceAgent() {
  return (
    <ConversationProvider>
      <VoiceAgentPanel />
    </ConversationProvider>
  );
}

function VoiceAgentPanel() {
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState("");

  const conversation = useConversation({
    // source "user" = התמלול שלך, "ai" = תשובת הסוכן
    onMessage: ({ source, message }) => setLines((prev) => [...prev, { source, text: message }]),
    onError: (message) => setError(message),
  });

  async function start() {
    setError("");
    try {
      // בקשת הרשאה למיקרופון מראש, כדי לקבל הודעת שגיאה ברורה
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());

      const res = await fetch("/api/elevenlabs/signed-url");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      conversation.startSession({ signedUrl: data.signedUrl, connectionType: "websocket" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const live = conversation.status === "connected";

  return (
    <div dir="rtl">
      <button onClick={live ? () => conversation.endSession() : start}>
        {live ? "סיים שיחה" : "התחל שיחה"}
      </button>
      <p>{live ? (conversation.isSpeaking ? "הסוכן מדבר" : "מקשיב לך") : conversation.status}</p>
      {error && <p role="alert">{error}</p>}
      {lines.map((l, i) => (
        <p key={i} dir="auto">
          <b>{l.source === "user" ? "אתה" : "הסוכן"}:</b> {l.text}
        </p>
      ))}
    </div>
  );
}
```

### JavaScript רגיל

```bash
npm install @elevenlabs/client@1.30.0
```

```js
import { Conversation } from "@elevenlabs/client";

const { signedUrl } = await fetch("/api/elevenlabs/signed-url").then((r) => r.json());

const conversation = await Conversation.startSession({
  signedUrl,
  connectionType: "websocket",
  onMessage: ({ source, message }) => console.log(source === "user" ? "אתה:" : "הסוכן:", message),
  onModeChange: ({ mode }) => console.log(mode), // "speaking" | "listening"
  onStatusChange: ({ status }) => console.log(status),
  onError: (message) => console.error(message),
});

// בסיום:
await conversation.endSession();
```

דוגמה מלאה, עם בחירת מיקרופון, מדי עוצמה, זמן תגובה ואזהרה כשהמיקרופון שקט, נמצאת ב-[public/app.js](public/app.js).

## מה למדנו בדרך (חשוב לעברית)

| נושא | מה עושים | למה |
| --- | --- | --- |
| מודל קול | `eleven_v4_turbo` (או `eleven_v4` / `eleven_v3`) | `eleven_multilingual_v2`, `flash_v2_5` ו-`turbo_v2_5` לא תומכים בעברית ומפיקים קול לא מובן |
| שפה | `language: "he"` | נועל את התמלול ואת הקול לעברית |
| `expressive_mode` | `false` | כשהוא דלוק, מודל השפה מכניס לתשובה תגיות כמו "[מיוחדת]" |
| `turn_eagerness` | `"normal"` | `"eager"` קטע את המשתמש באמצע משפט ("אני רוצה-") |
| חיבור | WebSocket עם `signedUrl` | טוקן WebRTC תופס מקום במכסת השיחות במקביל כבר כשמנפיקים אותו, והחשבון החינמי נחסם (429) אחרי 5 ניסיונות |
| `enable_auth` | `true` על הסוכן | בלי זה, כל מי שיודע את ה-agent ID יכול לדבר עם הסוכן על חשבונך |
| מיקרופון | https או localhost בלבד | הדפדפן חוסם גישה למיקרופון באתר http רגיל |
| מפתח API | רק בשרת | לעולם לא בקוד של הדפדפן |

## בדיקה

הטסטים של הריפו הזה עובדים גם מול סוכן אחר, כל עוד מגדירים את ה-ID שלו ב-`.env`:

```bash
npm start              # בטרמינל אחד
npm test               # שיחה קולית אמיתית: שאלה מוקלטת בעברית, ובדיקה של התמלול, התשובה וזמן התגובה
npm run test:browser   # הדשבורד ב-Chrome headless עם מיקרופון מזויף
```
