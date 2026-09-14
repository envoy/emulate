import { randomUUID } from "node:crypto";
import type { Store } from "@emulators/core";
import type { GoogleCalendarEvent } from "./entities.js";
import { listCalendarEvents, type ListCalendarEventsOptions } from "./calendar-helpers.js";
import type { GoogleStore } from "./store.js";

interface SyncSnapshot {
  token: string;
  userEmail: string;
  calendarId: string;
  baseline: GoogleCalendarEvent[];
  items: GoogleCalendarEvent[];
  updated: string;
  requestKey: string;
}

export class CalendarSyncError extends Error {
  constructor(
    public status: 400 | 410,
    message: string,
  ) {
    super(message);
  }
}

// Snapshots freeze paginated results and the associated sync boundary. Retaining
// the full prior state also lets incremental sync report deleted event IDs.
export function syncCalendarEvents(
  store: Store,
  gs: GoogleStore,
  userEmail: string,
  calendarId: string,
  options: ListCalendarEventsOptions & { syncToken?: string | null; showDeleted?: string | null },
) {
  const snapshots = store.getData<SyncSnapshot[]>("google.calendar_sync") ?? [];
  const limit = Number(options.maxResults ?? 250);
  if (!Number.isInteger(limit) || limit < 1 || limit > 2500) throw new CalendarSyncError(400, "Invalid maxResults.");
  if (
    options.syncToken &&
    (options.timeMin || options.timeMax || options.q || options.orderBy || options.showDeleted === "false")
  ) {
    throw new CalendarSyncError(400, "Incompatible sync parameters.");
  }
  const requestKey = JSON.stringify({ ...options, pageToken: undefined });
  let snapshot: SyncSnapshot | undefined;
  let offset = 0;
  if (options.pageToken) {
    const [token, rawOffset] = options.pageToken.split(":");
    offset = Number(rawOffset);
    snapshot = snapshots.find(
      (entry) => entry.token === token && entry.userEmail === userEmail && entry.calendarId === calendarId,
    );
    if (!snapshot || !Number.isInteger(offset) || offset < 0 || snapshot.requestKey !== requestKey) {
      throw new CalendarSyncError(400, "Invalid page token.");
    }
  } else {
    const baseline = structuredClone(
      gs.calendarEvents.findBy("user_email", userEmail).filter((event) => event.calendar_google_id === calendarId),
    );
    const items: GoogleCalendarEvent[] = [];
    if (options.syncToken) {
      const previous = snapshots.find(
        (entry) =>
          entry.token === options.syncToken && entry.userEmail === userEmail && entry.calendarId === calendarId,
      );
      if (!previous) throw new CalendarSyncError(410, "Sync token expired or invalid.");
      const oldEvents = new Map(previous.baseline.map((event) => [event.google_id, event]));
      for (const event of baseline) {
        if (JSON.stringify(oldEvents.get(event.google_id)) !== JSON.stringify(event)) items.push(event);
        oldEvents.delete(event.google_id);
      }
      items.push(...Array.from(oldEvents.values(), (event) => ({ ...event, status: "cancelled" })));
    } else {
      let pageToken: string | undefined;
      do {
        const page = listCalendarEvents(gs, userEmail, calendarId, { ...options, maxResults: "250", pageToken });
        items.push(...page.items);
        pageToken = page.nextPageToken;
      } while (pageToken);
      if (options.showDeleted === "true") items.push(...baseline.filter((event) => event.status === "cancelled"));
    }
    snapshot = {
      token: randomUUID(),
      userEmail,
      calendarId,
      baseline,
      items: structuredClone(items),
      updated: new Date().toISOString(),
      requestKey,
    };
    snapshots.push(snapshot);
    // Bounded retention; evicted tokens trigger the client's normal full resync.
    store.setData("google.calendar_sync", snapshots.slice(-1000));
  }
  const hasMore = offset + limit < snapshot.items.length;
  return {
    items: snapshot.items.slice(offset, offset + limit),
    updated: snapshot.updated,
    nextPageToken: hasMore ? `${snapshot.token}:${offset + limit}` : undefined,
    nextSyncToken: hasMore ? undefined : snapshot.token,
  };
}
