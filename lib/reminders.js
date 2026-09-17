// Local reminder store. No account, no network call — just a JSON file next to the project.
// Deliberately tiny: read-modify-write the whole file per change. Reminder volume for one
// person never gets big enough for that to matter.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, "..", "data", "reminders.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    return [];
  }
}
function save(list) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(list, null, 2));
}

export function addReminder({ text, due_at, recurring }) {
  if (!text || !text.trim()) throw new Error("text is required");
  const list = load();
  const reminder = {
    id: `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: text.trim(),
    due_at: due_at || null, // ISO 8601 or null for "no specific time"
    recurring: recurring || null, // e.g. "daily", "weekly" — informational only, no scheduler
    created_at: new Date().toISOString(),
    completed: false,
  };
  list.push(reminder);
  save(list);
  return reminder;
}

export function listReminders({ include_completed = false } = {}) {
  const list = load();
  const filtered = include_completed ? list : list.filter((r) => !r.completed);
  // Soonest-due first; reminders with no due date sort after ones that have one.
  return filtered.sort((a, b) => {
    if (a.due_at && b.due_at) return a.due_at.localeCompare(b.due_at);
    if (a.due_at) return -1;
    if (b.due_at) return 1;
    return a.created_at.localeCompare(b.created_at);
  });
}

export function completeReminder({ id }) {
  const list = load();
  const r = list.find((x) => x.id === id);
  if (!r) throw new Error(`No reminder with id ${id}`);
  r.completed = true;
  r.completed_at = new Date().toISOString();
  save(list);
  return r;
}

export function deleteReminder({ id }) {
  const list = load();
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) throw new Error(`No reminder with id ${id}`);
  save(next);
  return { id, deleted: true };
}
