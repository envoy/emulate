import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import type { GoogleDirectoryBuilding, GoogleDirectoryCalendarResource } from "../entities.js";
import { googlePlugin, seedFromConfig } from "../index.js";

describe("Directory room discovery", () => {
  it("discovers paginated buildings and usable room calendars without leaking another user's resources", async () => {
    const store = new Store();
    const tokens: TokenMap = new Map([
      ["owner", { login: "owner@example.com", id: 1, scopes: [] }],
      ["other", { login: "other@example.com", id: 2, scopes: [] }],
    ]);
    const app = new Hono();
    app.use("*", authMiddleware(tokens));
    googlePlugin.register(app, store, new WebhookDispatcher(), "http://localhost", tokens);
    const seed = {
      users: [{ email: "owner@example.com" }],
      directory_buildings: [
        { buildingId: "hq", buildingName: "HQ", floorNames: ["1"] },
        { buildingId: "annex", buildingName: "Annex" },
      ],
      directory_calendar_resources: [
        {
          resourceId: "room-1",
          resourceEmail: "room-1@resource.calendar.google.com",
          resourceName: "Meeting Room",
          buildingId: "hq",
          floorName: "1",
          capacity: 6,
        },
      ],
    };
    seedFromConfig(store, "http://localhost", seed);
    seedFromConfig(store, "http://localhost", seed);
    const root = "/admin/directory/v1/customer/my_customer/resources/";
    const get = (path: string, token = "owner") => app.request(path, { headers: { Authorization: `Bearer ${token}` } });
    const first = (await (await get(root + "buildings?maxResults=1")).json()) as {
      buildings: GoogleDirectoryBuilding[];
      nextPageToken: string;
    };
    expect(first.buildings).toEqual([expect.objectContaining({ buildingId: "hq", buildingName: "HQ" })]);
    expect(first.buildings[0]).not.toHaveProperty("user_email");
    const second = (await (await get(root + `buildings?maxResults=1&pageToken=${first.nextPageToken}`)).json()) as {
      buildings: GoogleDirectoryBuilding[];
      nextPageToken?: string;
    };
    expect(second.buildings[0].buildingId).toBe("annex");
    expect(second.nextPageToken).toBeUndefined();
    expect(await (await get(root + "buildings/hq")).json()).toMatchObject({ buildingId: "hq", buildingName: "HQ" });
    expect((await get(root + "buildings/hq", "other")).status).toBe(404);
    const rooms = (await (await get(root + "calendars")).json()) as { items: GoogleDirectoryCalendarResource[] };
    expect(rooms.items).toHaveLength(1);
    expect(rooms.items[0]).toMatchObject({ resourceId: "room-1", capacity: 6, buildingId: "hq" });
    const eventsUrl = `/calendar/v3/calendars/${encodeURIComponent(rooms.items[0].resourceEmail)}/events`;
    const created = await app.request(eventsUrl, {
      method: "POST",
      headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "booking-id",
        organizer: { email: "organizer@example.com" },
        summary: "Room booking",
        start: { dateTime: "2026-09-05T10:00:00Z" },
        end: { dateTime: "2026-09-05T11:00:00Z" },
      }),
    });
    expect(created.status).toBe(200);
    const createdEvent = (await created.json()) as { id: string; organizer: { email: string } };
    expect(createdEvent).toMatchObject({ id: "booking-id", organizer: { email: "organizer@example.com" } });
    for (const [body, expectedStatus] of [
      [{ id: "booking-id" }, 409],
      [{ recurrence: ["RRULE:FREQ=DAILY"] }, 400],
    ] as const) {
      const result = await app.request(eventsUrl, {
        method: "POST",
        headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, start: { date: "2026-09-05" }, end: { date: "2026-09-06" } }),
      });
      expect(result.status).toBe(expectedStatus);
    }
    const patched = await app.request(eventsUrl + "/booking-id", {
      method: "POST",
      headers: { Authorization: "Bearer owner", "Content-Type": "application/json", "X-HTTP-Method-Override": "PATCH" },
      body: JSON.stringify({ summary: "Room booking", id: "cannot-change-id" }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ id: "booking-id", organizer: { email: "organizer@example.com" } });
    expect(((await (await get(eventsUrl)).json()) as { items: Array<{ summary: string }> }).items[0].summary).toBe(
      "Room booking",
    );
    expect(((await (await get(root + "calendars", "other")).json()) as { items: unknown[] }).items).toEqual([]);
    expect((await get(eventsUrl, "other")).status).toBe(404);
    expect((await app.request(root + "buildings")).status).toBe(401);
    expect((await get(root + "buildings?maxResults=0")).status).toBe(400);
    expect((await get(root + "buildings?pageToken=invalid")).status).toBe(400);
    expect((await get(root.replace("my_customer", "unknown") + "buildings")).status).toBe(404);
  });
});
