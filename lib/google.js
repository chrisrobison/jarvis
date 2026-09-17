// Google OAuth + Gmail + Calendar, all via plain REST (no googleapis dependency).
//
// One-time setup (Google Cloud Console): create an OAuth 2.0 Client ID (type "Web application"),
// add http://localhost:<PORT>/auth/google/callback as an authorized redirect URI, and enable the
// Gmail API + Google Calendar API for the project. Put the client id/secret in .env.
//
// The refresh token is the only long-lived secret; it's written to data/google-tokens.json (gitignored)
// the same way the rest of this app writes secrets to .env — once granted, it survives restarts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.join(__dirname, "..", "data", "google-tokens.json");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar",
].join(" ");

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")); } catch { return null; }
}
function saveTokens(tokens) {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

export function isConnected() {
  return Boolean(loadTokens()?.refresh_token);
}

export function buildAuthUrl({ clientId, redirectUri }) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent"); // force a refresh_token every time, not just on first grant
  return url.toString();
}

export async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`Google token exchange ${r.status}: ${JSON.stringify(body)}`);
  saveTokens({ refresh_token: body.refresh_token, access_token: body.access_token, expires_at: Date.now() + body.expires_in * 1000 });
}

export function disconnect() {
  try { fs.unlinkSync(TOKEN_PATH); } catch {}
}

// Access tokens expire in ~1h; refresh a little early and cache in memory + on disk.
async function getAccessToken({ clientId, clientSecret }) {
  const tokens = loadTokens();
  if (!tokens?.refresh_token) throw new Error("Google isn't connected yet. Use the Connect Google button.");
  if (tokens.access_token && tokens.expires_at > Date.now() + 30_000) return tokens.access_token;

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`Google token refresh ${r.status}: ${JSON.stringify(body)}`);
  const next = { ...tokens, access_token: body.access_token, expires_at: Date.now() + body.expires_in * 1000 };
  saveTokens(next);
  return next.access_token;
}

async function googleFetch(url, creds, init = {}) {
  const token = await getAccessToken(creds);
  const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google API ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

export async function listUpcomingEvents({ max_results = 5, days_ahead = 7 } = {}, creds) {
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + days_ahead * 86400_000).toISOString();
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("maxResults", String(Math.min(Math.max(max_results, 1), 20)));
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  const body = await googleFetch(url, creds);
  return (body.items || []).map((e) => ({
    id: e.id,
    summary: e.summary || "(no title)",
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location || null,
  }));
}

export async function createCalendarEvent({ summary, start_iso, end_iso, description, timezone }, creds) {
  if (!summary || !start_iso || !end_iso) throw new Error("summary, start_iso and end_iso are required");
  const body = await googleFetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", creds, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      summary,
      description: description || undefined,
      start: { dateTime: start_iso, timeZone: timezone || undefined },
      end: { dateTime: end_iso, timeZone: timezone || undefined },
    }),
  });
  return { id: body.id, summary: body.summary, start: body.start?.dateTime, end: body.end?.dateTime, htmlLink: body.htmlLink };
}

export async function searchEmails({ query, max_results = 5 }, creds) {
  if (!query || !query.trim()) throw new Error("query is required");
  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", query.trim());
  listUrl.searchParams.set("maxResults", String(Math.min(Math.max(max_results, 1), 10)));
  const list = await googleFetch(listUrl, creds);
  const ids = (list.messages || []).map((m) => m.id);
  const results = [];
  for (const id of ids) {
    const msgUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
    msgUrl.searchParams.set("format", "metadata");
    for (const h of ["Subject", "From", "Date"]) msgUrl.searchParams.append("metadataHeaders", h);
    const msg = await googleFetch(msgUrl, creds);
    const headers = Object.fromEntries((msg.payload?.headers || []).map((h) => [h.name, h.value]));
    results.push({
      id,
      subject: headers.Subject || "(no subject)",
      from: headers.From || "",
      date: headers.Date || "",
      snippet: msg.snippet || "",
    });
  }
  return results;
}
