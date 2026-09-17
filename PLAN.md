# Jarvis — Plan

A voice-only personal agent: no video avatar, just a dry, sarcastic, JARVIS-style voice that
listens, thinks with Claude, talks back, and can actually *do* things on your behalf — search the
web, track reminders, check your calendar, read your email. Forked from `talking-avatar-starter`,
keeping the Deepgram Voice Agent plumbing and the Deepgram API key, dropping Anam entirely.

## Why this exists

The original project spent a lot of its complexity budget on rendering a lip-synced video face.
That's neat for a demo but it's not what makes an assistant useful day to day, and it's one more
thing to render, one more API to depend on, one more thing that can lag. The bet here is that a
personality you actually enjoy talking to, plus real capabilities (it remembers things, it checks
your calendar before you ask), beats a face.

## Architecture

```
 browser mic → AudioWorklet (PCM16 @ 16kHz) → ws /agent → this server → Deepgram Voice Agent
                                                                              │
                                                            (listen: Deepgram STT)
                                                            (think:  Claude, via Deepgram)
                                                            (speak:  Deepgram TTS)
                                                                              │
 browser Web Audio (queued PCM playback) ← ws /agent ← this server ← Deepgram TTS audio
```

When Claude decides to use a tool mid-conversation, Deepgram sends a `FunctionCallRequest` down
the same socket. The server runs the tool locally (reminders file, Brave search, Google APIs) and
replies with a `FunctionCallResponse`. Nothing about tool execution ever touches the browser —
same principle as the original project keeping API keys server-side only.

This is the same shape as `talking-avatar-starter`'s `server.js`, minus every Anam-specific route
(`/api/anam-session`, `/api/avatars`, the avatar picker) and plus the function-calling loop and
the OAuth routes for Google.

## What's built (v1 — done, verified against the live Deepgram API)

- **Voice loop** — `server.js`, `public/app.js`, `public/mic-worklet.js` (mic capture copied
  unchanged from the original project). TTS audio is played directly with the Web Audio API
  (a small hand-rolled PCM streaming player in `app.js`) instead of routing through Anam's SDK.
  Barge-in (interrupting Jarvis) stops playback immediately.
- **Personality** — `prompts/jarvis.md`. Dry, understated, addresses you as "sir," makes jokes at
  your expense when you've earned it, stays brief because a butler doesn't monologue. On session
  start it proactively checks reminders and (if connected) the calendar before it even says hello,
  so the opening line can be a real status update, not just "hi."
- **Reminders** (`lib/reminders.js`) — local JSON file, no account needed. Full CRUD:
  `add_reminder`, `list_reminders`, `complete_reminder`, `delete_reminder`. Also browsable outside
  a conversation at `GET /api/reminders`, and shown in the page's Reminders card.
- **Web search** (`lib/websearch.js`) — Brave Search API. One function, `web_search`. Needs a free
  API key (see Setup below); until then it degrades gracefully — Jarvis is told search isn't
  configured and says so instead of guessing.
- **Google Calendar + Gmail** (`lib/google.js`) — full OAuth2 flow (`/auth/google`,
  `/auth/google/callback`), token refresh, and three functions: `list_upcoming_events`,
  `create_calendar_event`, `search_emails`. Needs a Google Cloud OAuth client (see Setup below).
- **Tool registry** (`lib/functions.js`) — the JSON Schema definitions sent to Deepgram plus the
  dispatcher that runs the matching local function when a `FunctionCallRequest` comes in.

All of the above was smoke-tested against the real Deepgram Voice Agent endpoint, not just
unit-tested locally — including one real bug (a `client_side` field I'd added to the function
schema that Deepgram's parser rejects) that got caught and fixed that way.

## Setup still needed from you

Both are optional — the voice loop, personality, and reminders all work with zero extra setup
beyond the Deepgram key, which is already carried over from `talking-avatar-starter`'s `.env`.

1. **Web search** — free key at https://api-dashboard.search.brave.com, paste into the Brave
   field in the keys panel (card 1).
2. **Gmail + Calendar** — in [Google Cloud Console](https://console.cloud.google.com/apis/credentials):
   create an OAuth 2.0 **Web application** client, add redirect URI
   `http://localhost:4400/auth/google/callback`, enable the **Gmail API** and **Google Calendar
   API**. Paste the Client ID/Secret into the Google card (card 3) and click **Connect Google**.

## Not built yet / ideas for v2

Nothing beyond v1 has been started. Rough order of what would matter most, if you want to keep
going:

- **A real scheduler for reminders.** Right now reminders are stored but nothing ever proactively
  surfaces one unless you're mid-conversation and ask, or a session just started. A due reminder
  at 3pm won't make Jarvis say anything at 3pm — there's no conversation happening to say it in.
  Options: a system notification (needs a native/OS layer, this is a browser tab); or Jarvis stays
  "listening" persistently rather than only during an explicit session.
- **Always-on / wake-word mode.** Currently you click Start/Stop per conversation. A real JARVIS
  is always half-listening. Would need a wake-word detector (e.g. Porcupine) running locally so
  the mic isn't streaming to Deepgram 24/7, then opening the real session on trigger.
- **Memory across sessions.** Right now each conversation starts fresh apart from reminders/
  calendar. No memory of "we talked about X yesterday." Would need a transcript log plus some
  retrieval/summarization step fed into the prompt or context.
- **Sending on your behalf.** Email/calendar tools are read + calendar-create only right now, on
  purpose — no "send this email" function. Worth adding deliberately, with the same care the rest
  of this project takes around not silently sending things a user didn't ask for.
- **Multiple personas.** The `prompts/index.json` mechanism from the original project is still
  here (in case you want a second character later); v1 just has the one entry, Jarvis.
