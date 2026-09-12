import { randomUUID } from "node:crypto";
import type { RouteContext } from "@emulators/core";
import { getMicrosoftStore } from "../store.js";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function validActivity(value: unknown): value is Record<string, unknown> {
  if (!object(value) || value.type !== "message") return false;
  if (value.text !== undefined && typeof value.text !== "string") return false;
  if (
    value.attachments !== undefined &&
    (!Array.isArray(value.attachments) ||
      !value.attachments.every(
        (a) =>
          object(a) && typeof a.contentType === "string" && (object(a.content) || typeof a.contentUrl === "string"),
      ))
  )
    return false;
  return Boolean(value.text || (Array.isArray(value.attachments) && value.attachments.length));
}

/** Graph discovery and Bot Connector messaging are separate provider boundaries. */
export function teamsRoutes({ app, store, tokenMap, baseUrl }: RouteContext): void {
  const ms = getMicrosoftStore(store);
  for (const path of [
    "/v3/:rest{.*}",
    "/_emulator/teams/:rest{.*}",
    "/v1.0/users",
    "/v1.0/users/:userId/teamwork/:rest{.*}",
    "/v1.0/organization",
  ]) {
    app.use(path, async (c, next) => {
      const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "");
      const identity = match && tokenMap?.get(match[1]);
      if (!identity)
        return c.json(
          { error: { code: "InvalidAuthenticationToken", message: "A valid bearer token is required." } },
          401,
        );
      const bot = path === "/v3/:rest{.*}" || path === "/_emulator/teams/:rest{.*}";
      const required = bot ? "https://api.botframework.com/.default" : "https://graph.microsoft.com/.default";
      if (!identity.scopes.includes(required))
        return c.json({ error: { code: "Authorization_RequestDenied", message: `Required scope: ${required}` } }, 403);
      c.set("authUser", identity);
      await next();
    });
  }

  // The SDK uses tenant-qualified token URLs, including botframework.com.
  app.post("/:tenant/oauth2/v2.0/token", async (c) => {
    const body = await c.req.text();
    return app.request(
      new Request(`${baseUrl}/oauth2/v2.0/token`, {
        method: "POST",
        headers: c.req.raw.headers,
        body,
      }),
    );
  });

  app.get("/v1.0/users", (c) => {
    const filter = c.req.query("$filter");
    const match = filter && /^mail eq '((?:[^']|'')*)'$/.exec(filter);
    if (filter && !match)
      return c.json({ error: { code: "BadRequest", message: "Only mail eq filters are supported." } }, 400);
    const selected = c.req.query("$select")?.split(",");
    const value = ms.users
      .all()
      .filter((u) => !match || u.email === match[1].replaceAll("''", "'"))
      .map((u) => {
        const profile: Record<string, unknown> = {
          id: u.oid,
          mail: u.email,
          displayName: u.name,
          userPrincipalName: u.preferred_username,
          accountEnabled: true,
          deletedDateTime: null,
        };
        return selected
          ? Object.fromEntries(Object.entries(profile).filter(([key]) => selected.includes(key)))
          : profile;
      });
    return c.json({ value });
  });
  app.get("/v1.0/organization", (c) =>
    c.json({
      value: [...new Set(ms.users.all().map((u) => u.tenant_id))].map((id) => ({
        id,
        displayName: "Emulated organization",
      })),
    }),
  );
  app.get("/v1.0/users/:userId/teamwork/installedApps", (c) => {
    if (!ms.users.findOneBy("oid", c.req.param("userId")))
      return c.json({ error: { code: "Request_ResourceNotFound", message: "User not found." } }, 404);
    const filter = c.req.query("$filter");
    const match = filter && /^teamsApp\/(id|externalId) eq '((?:[^']|'')*)'$/.exec(filter);
    if (filter && !match)
      return c.json({ error: { code: "BadRequest", message: "Unsupported installed-app filter." } }, 400);
    return c.json({
      value: ms.installations
        .findBy("user_id", c.req.param("userId"))
        .filter((i) => !match || (match[1] === "id" ? i.app_id : i.external_id) === match[2].replaceAll("''", "'"))
        .map((i) => ({ id: i.installation_id, teamsApp: { id: i.app_id, externalId: i.external_id } })),
    });
  });
  app.get("/v1.0/users/:userId/teamwork/installedApps/:installationId/chat", (c) => {
    const installation = ms.installations
      .findBy("user_id", c.req.param("userId"))
      .find((i) => i.installation_id === c.req.param("installationId"));
    const conversation = installation && ms.conversations.findOneBy("conversation_id", installation.conversation_id);
    if (!conversation) return c.json({ error: { code: "NotFound", message: "Installed app chat not found." } }, 404);
    return c.json({
      id: conversation.conversation_id,
      tenantId: conversation.tenant_id,
      chatType: conversation.is_group ? "group" : "oneOnOne",
    });
  });

  app.post("/v3/conversations", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (
      !object(body) ||
      !object(body.bot) ||
      typeof body.bot.id !== "string" ||
      !Array.isArray(body.members) ||
      !body.members.length ||
      !body.members.every((m) => object(m) && typeof m.id === "string") ||
      (body.activity !== undefined && !validActivity(body.activity))
    )
      return c.json(
        { error: { code: "BadArgument", message: "Bot, members and a valid optional message activity are required." } },
        400,
      );
    if (body.bot.id !== c.get("authUser")?.login)
      return c.json({ error: { code: "Forbidden", message: "Bot identity does not match token." } }, 403);
    const channelData = object(body.channelData) ? body.channelData : {};
    const tenant = object(channelData.tenant) ? channelData.tenant.id : undefined;
    const conversation = ms.conversations.insert({
      conversation_id: randomUUID(),
      bot_id: body.bot.id,
      tenant_id: typeof body.tenantId === "string" ? body.tenantId : typeof tenant === "string" ? tenant : "",
      members: body.members as Array<{ id: string }>,
      is_group: body.isGroup === true,
    });
    let activityId: string | undefined;
    if (validActivity(body.activity)) {
      activityId = randomUUID();
      ms.activities.insert({
        activity_id: activityId,
        conversation_id: conversation.conversation_id,
        payload: { ...body.activity, id: activityId },
      });
    }
    return c.json({ id: conversation.conversation_id, activityId, serviceUrl: baseUrl }, 201);
  });

  for (const prefix of ["/v3/conversations/:conversationId", "/_emulator/teams/conversations/:conversationId"]) {
    app.use(`${prefix}/:rest{.*}`, async (c, next) => {
      const conversation = ms.conversations.findOneBy("conversation_id", c.req.param("conversationId")!);
      if (!conversation)
        return c.json({ error: { code: "ConversationNotFound", message: "Conversation not found." } }, 404);
      if (conversation.bot_id !== c.get("authUser")?.login || conversation.blocked)
        return c.json(
          { error: { code: "BotNotInConversationRoster", message: "Bot cannot access this conversation." } },
          403,
        );
      await next();
    });
  }
  for (const route of [
    "/v3/conversations/:conversationId/activities",
    "/v3/conversations/:conversationId/activities/:activityId",
  ]) {
    app.post(route, async (c) => {
      const body: unknown = await c.req.json().catch(() => null);
      if (!validActivity(body))
        return c.json(
          { error: { code: "BadArgument", message: "A message with text or attachments is required." } },
          400,
        );
      const replyToId = c.req.param("activityId");
      if (
        replyToId &&
        !ms.activities.findBy("conversation_id", c.req.param("conversationId")).some((a) => a.activity_id === replyToId)
      )
        return c.json({ error: { code: "MessageNotFound", message: "Reply target not found." } }, 404);
      const id = randomUUID();
      ms.activities.insert({
        activity_id: id,
        conversation_id: c.req.param("conversationId"),
        payload: { ...body, id, ...(replyToId ? { replyToId } : {}) },
      });
      return c.json({ id }, 200);
    });
  }
  app.put("/v3/conversations/:conversationId/activities/:activityId", async (c) => {
    const activity = ms.activities
      .findBy("conversation_id", c.req.param("conversationId"))
      .find((a) => a.activity_id === c.req.param("activityId"));
    if (!activity) return c.json({ error: { code: "MessageNotFound", message: "Activity not found." } }, 404);
    const body: unknown = await c.req.json().catch(() => null);
    if (!validActivity(body))
      return c.json({ error: { code: "BadArgument", message: "Invalid message activity." } }, 400);
    ms.activities.update(activity.id, { payload: { ...body, id: activity.activity_id } });
    return c.json({ id: activity.activity_id });
  });
  app.delete("/v3/conversations/:conversationId/activities/:activityId", (c) => {
    const activity = ms.activities
      .findBy("conversation_id", c.req.param("conversationId"))
      .find((a) => a.activity_id === c.req.param("activityId"));
    if (!activity) return c.json({ error: { code: "MessageNotFound", message: "Activity not found." } }, 404);
    ms.activities.delete(activity.id);
    return c.body(null, 200);
  });
  // Connector has no read-history API; this explicitly local route is for assertions.
  app.get("/_emulator/teams/conversations/:conversationId/activities", (c) =>
    c.json({
      activities: ms.activities
        .findBy("conversation_id", c.req.param("conversationId"))
        .sort((a, b) => a.id - b.id)
        .map((a) => a.payload),
    }),
  );
}
