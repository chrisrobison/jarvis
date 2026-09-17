// The tool registry: JSON Schema declarations sent to Deepgram in Settings.agent.think.functions,
// plus the local implementations that run when Deepgram sends a FunctionCallRequest back for them.
// None of these declare an `endpoint`, which is what makes Deepgram treat them as client-side —
// it sends us a FunctionCallRequest and waits for our FunctionCallResponse, rather than calling
// a URL itself.
import * as reminders from "./reminders.js";
import { webSearch } from "./websearch.js";
import * as google from "./google.js";

export const FUNCTION_DEFINITIONS = [
  {
    name: "web_search",
    description: "Search the live web for current information — news, facts, prices, anything that might have changed since training. Use whenever the user asks about something you're not certain is still true.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
    },
  },
  {
    name: "add_reminder",
    description: "Save a reminder for the user. Use whenever the user asks to be reminded of something, or mentions a task/date worth tracking.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to remind the user about." },
        due_at: { type: "string", description: "ISO 8601 date/time it's due, if any. Omit for an open-ended reminder." },
        recurring: { type: "string", description: "e.g. 'daily', 'weekly'. Omit for a one-off." },
      },
      required: ["text"],
    },
  },
  {
    name: "list_reminders",
    description: "List the user's saved reminders, soonest due first. Use this at the start of a conversation and whenever the user asks what they need to do.",
    parameters: {
      type: "object",
      properties: {
        include_completed: { type: "boolean", description: "Include already-completed reminders. Default false." },
      },
      required: [],
    },
  },
  {
    name: "complete_reminder",
    description: "Mark a reminder as done.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The reminder's id, from list_reminders." } },
      required: ["id"],
    },
  },
  {
    name: "delete_reminder",
    description: "Delete a reminder outright (use complete_reminder instead if it was actually done).",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The reminder's id, from list_reminders." } },
      required: ["id"],
    },
  },
  {
    name: "list_upcoming_events",
    description: "List the user's upcoming Google Calendar events. Use this at the start of a conversation and whenever the user asks about their schedule, meetings, or what's coming up.",
    parameters: {
      type: "object",
      properties: {
        days_ahead: { type: "number", description: "How many days ahead to look. Default 7." },
        max_results: { type: "number", description: "Max events to return. Default 5." },
      },
      required: [],
    },
  },
  {
    name: "create_calendar_event",
    description: "Create a new event on the user's Google Calendar.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title." },
        start_iso: { type: "string", description: "Start time, ISO 8601 with timezone offset." },
        end_iso: { type: "string", description: "End time, ISO 8601 with timezone offset." },
        description: { type: "string", description: "Optional longer description." },
      },
      required: ["summary", "start_iso", "end_iso"],
    },
  },
  {
    name: "search_emails",
    description: "Search the user's Gmail inbox. Use Gmail search syntax in the query (e.g. 'from:boss@x.com is:unread', 'subject:invoice').",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query." },
        max_results: { type: "number", description: "Max results. Default 5." },
      },
      required: ["query"],
    },
  },
];

// ctx: { braveKey, googleCreds: {clientId, clientSecret}, googleConnected }
export async function callFunction(name, args, ctx) {
  switch (name) {
    case "web_search":
      return webSearch(args, ctx.braveKey);
    case "add_reminder":
      return reminders.addReminder(args);
    case "list_reminders":
      return reminders.listReminders(args);
    case "complete_reminder":
      return reminders.completeReminder(args);
    case "delete_reminder":
      return reminders.deleteReminder(args);
    case "list_upcoming_events":
      if (!ctx.googleConnected) return { error: "Google Calendar isn't connected yet. Ask the user to click Connect Google." };
      return google.listUpcomingEvents(args, ctx.googleCreds);
    case "create_calendar_event":
      if (!ctx.googleConnected) return { error: "Google Calendar isn't connected yet. Ask the user to click Connect Google." };
      return google.createCalendarEvent(args, ctx.googleCreds);
    case "search_emails":
      if (!ctx.googleConnected) return { error: "Gmail isn't connected yet. Ask the user to click Connect Google." };
      return google.searchEmails(args, ctx.googleCreds);
    default:
      return { error: `Unknown function: ${name}` };
  }
}
