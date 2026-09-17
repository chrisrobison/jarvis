# Jarvis

A voice-only personal agent: no avatar, no video, just a dry, sarcastic, JARVIS-style voice that
listens, thinks with Claude, talks back, and can actually *do* things on your behalf — search the
web, track reminders, check your calendar, read your email.

Forked from `talking-avatar-starter`, keeping the Deepgram Voice Agent plumbing and dropping the
Anam video avatar entirely. The bet: a personality you enjoy talking to, plus real capabilities
(it remembers things, it checks your calendar before you ask), beats a face.

## How it works

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
replies with a `FunctionCallResponse`. Tool execution never touches the browser — API keys and
OAuth tokens stay server-side.

## Features

- **Voice loop** — real-time mic capture, barge-in (interrupting Jarvis stops playback
  immediately), and Deepgram's Flux STT/TTS pair by default (swappable for the older Aura voices).
- **Personality** — dry, understated, addresses you as "sir." On session start it proactively
  checks reminders and (if connected) your calendar before it says a word, so the opening line is
  a real status update instead of "hi."
- **Reminders** — local JSON file, no account needed. Full CRUD (add / list / complete / delete),
  also browsable outside a conversation at `GET /api/reminders` and shown live in the page's
  Reminders card.
- **Web search** — via the Brave Search API. Degrades gracefully with no key configured; Jarvis
  just tells you search isn't set up instead of guessing.
- **Google Calendar + Gmail** — full OAuth2 flow, token refresh, and three tools:
  `list_upcoming_events`, `create_calendar_event`, `search_emails`. Read + calendar-create only,
  no email sending, on purpose.
- **In-page setup** — API keys and Google OAuth credentials can be pasted directly into the page;
  they're written back to `.env` so they survive a restart. No config files to hand-edit.

## Requirements

- Node.js 18+ (tested on Node 22)
- A [Deepgram](https://console.deepgram.com/) API key (required — this is what does the listening
  and speaking, and by default brokers the Claude calls too)

Everything else below is optional.

## Setup

```bash
git clone https://github.com/chrisrobison/jarvis.git
cd jarvis
npm install
cp .env.example .env
```

Edit `.env` and set at least `DEEPGRAM_API_KEY` (or leave it blank and paste it into the page on
first load — either works). Then:

```bash
npm start
```

Open `http://localhost:4400` in Chrome, allow microphone access, and hit **Start conversation**.

> Wear headphones. Through open speakers Jarvis hears his own voice and starts talking to
> himself.

### Optional: web search

Free key at https://api-dashboard.search.brave.com — paste it into the Brave field in the keys
panel, or set `BRAVE_API_KEY` in `.env`.

### Optional: Gmail + Calendar

In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials):

1. Create an OAuth 2.0 **Web application** client.
2. Add redirect URI `http://localhost:4400/auth/google/callback`.
3. Enable the **Gmail API** and **Google Calendar API**.
4. Paste the Client ID/Secret into the Google card on the page (or set `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET` in `.env`) and click **Connect Google**.

### Optional: bring your own Anthropic key

By default Deepgram brokers the Claude call with its own credentials. Set `ANTHROPIC_API_KEY` in
`.env` if you'd rather use your own key (e.g. to pick a specific model via `THINK_MODEL`).

## Project structure

```
server.js            Express + WebSocket proxy, Deepgram Voice Agent session setup,
                      OAuth routes, key management
lib/
  functions.js        Tool registry: JSON Schema definitions + dispatcher
  reminders.js         Local reminders CRUD (data/reminders.json)
  websearch.js         Brave Search API wrapper
  google.js            Google OAuth2, Calendar, and Gmail
prompts/
  jarvis.md             The Jarvis persona/system prompt
  index.json            Registers available personas (just Jarvis for now)
public/
  index.html             The single-page UI
  app.js                  Mic capture, playback, transcript, keys/voice/Google panels
  mic-worklet.js           AudioWorklet for 16kHz PCM16 mic capture
```

## Roadmap

Nothing beyond v1 has been started yet. Roughly in order of what matters most:

- **A real scheduler for reminders.** Right now a due reminder doesn't proactively say anything —
  it only surfaces mid-conversation or at session start.
- **Always-on / wake-word mode.** A real JARVIS is always half-listening; this currently needs an
  explicit Start/Stop per conversation.
- **Memory across sessions.** No recall of past conversations beyond reminders/calendar state.
- **Sending on your behalf.** Email/calendar tools are read + calendar-create only, deliberately —
  no "send this email" yet.
- **Multiple personas.** The `prompts/index.json` mechanism supports more than one character;
  only Jarvis is defined so far.

## License

`package.json` declares ISC, but no `LICENSE` file has been added to the repo yet.
