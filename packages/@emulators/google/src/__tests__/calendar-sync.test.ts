import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { googlePlugin, seedFromConfig } from "../index.js";

type EventPage = {
  items: Array<{ id: string; summary: string; status: string }>;
  updated: string;
  nextPageToken?: string;
  nextSyncToken?: string;
};

describe("Calendar incremental synchronization", () => {
  it("freezes pages and reports updates and deletions after the snapshot boundary", async () => {
    const store = new Store();
    const tokens: TokenMap = new Map([["owner", { login: "owner@example.com", id: 1, scopes: [] }]]);
    const app = new Hono();
    app.use("*", authMiddleware(tokens));
    googlePlugin.register(app, store, new WebhookDispatcher(), "http://localhost", tokens);
    seedFromConfig(store, "http://localhost", {
      users: [{ email: "owner@example.com" }],
      calendars: [
        { id: "room", summary: "Room" },
        { id: "other", summary: "Other" },
      ],
      calendar_events: ["a", "b"].map((id) => ({
        id,
        calendar_id: "room",
        summary: id,
        start_date_time: "2026-09-05T10:00:00Z",
        end_date_time: "2026-09-05T11:00:00Z",
      })),
    });
    const path = "/calendar/v3/calendars/room/events";
    const request = (url: string, method = "GET", body?: unknown) =>
      app.request(url, {
        method,
        headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const page = async (query: string) => {
      const response = await request(path + query);
      expect(response.status).toBe(200);
      return (await response.json()) as EventPage;
    };
    const first = await page("?maxResults=1");
    expect(first.items[0].id).toBe("a");
    expect(Number.isFinite(Date.parse(first.updated))).toBe(true);
    expect(first.nextSyncToken).toBeUndefined();
    expect((await request(path + "/b", "PATCH", { summary: "Changed during paging" })).status).toBe(200);
    const second = await page(`?maxResults=1&pageToken=${first.nextPageToken}`);
    expect(second.items[0].summary).toBe("b");
    expect(second.nextPageToken).toBeUndefined();
    expect(second.nextSyncToken).toBeTruthy();
    expect((await request(path + "/a", "DELETE")).status).toBe(204);
    const changes = await page(`?syncToken=${second.nextSyncToken}&maxResults=1`);
    expect(changes.items[0]).toMatchObject({ id: "b", summary: "Changed during paging" });
    const deletion = await page(`?syncToken=${second.nextSyncToken}&maxResults=1&pageToken=${changes.nextPageToken}`);
    expect(deletion.items[0]).toMatchObject({ id: "a", status: "cancelled" });
    expect((await page(`?syncToken=${deletion.nextSyncToken}`)).items).toEqual([]);
    expect((await request(path + "?syncToken=invalid")).status).toBe(410);
    expect((await request(path.replace("/room/", "/other/") + `?syncToken=${deletion.nextSyncToken}`)).status).toBe(
      410,
    );
    expect((await request(path + `?syncToken=${deletion.nextSyncToken}&timeMin=2026-09-01T00:00:00Z`)).status).toBe(
      400,
    );
    expect((await request(path + "?pageToken=invalid")).status).toBe(400);
    store.reset();
    seedFromConfig(store, "http://localhost", {
      users: [{ email: "owner@example.com" }],
      calendars: [{ id: "room", summary: "Room" }],
    });
    expect((await request(path + `?syncToken=${deletion.nextSyncToken}`)).status).toBe(410);
  });
});
