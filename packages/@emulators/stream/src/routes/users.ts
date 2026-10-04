import type { RouteContext } from "@emulators/core";
import type { UserInput } from "../chat.js";
import { inputError, notAllowed } from "../errors.js";
import { compareBySort, matchesFilter, normalizeSort } from "../filters.js";
import { streamHandler, stringArrayField } from "../request.js";
import { setAppConfig } from "../store.js";

export function userRoutes({ app, store }: RouteContext): void {
  // upsertUsers: { users: { "<id>": { id, name, role, teams, ...custom } } }
  app.post(
    "/users",
    streamHandler(store, (request) => {
      const { chat, hub, body, userId } = request;
      const users = body.users;
      if (!users || typeof users !== "object" || Array.isArray(users))
        throw inputError("users must be an object keyed by id");
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(users as Record<string, unknown>)) {
        if (!value || typeof value !== "object") throw inputError(`users.${key} must be an object`);
        const input = { id: key, ...(value as Record<string, unknown>) } as UserInput;
        if (userId) {
          // A client may update only itself, and never its own role or teams.
          if (input.id !== userId) throw notAllowed(`user "${userId}" may not update user "${input.id}"`);
          delete input.role;
          delete input.teams;
        }
        const user = chat.upsertUser(input);
        result[user.user_id] = chat.formatUser(user, hub.isOnline(user.user_id));
      }
      return { users: result };
    }),
  );

  // partialUpdateUsers: { users: [{ id, set, unset }] }
  app.patch(
    "/users",
    streamHandler(store, (request) => {
      const { chat, hub, body, userId } = request;
      if (!Array.isArray(body.users)) throw inputError("users must be an array");
      const result: Record<string, unknown> = {};
      for (const entry of body.users as Array<Record<string, unknown>>) {
        if (typeof entry?.id !== "string") throw inputError("each user needs an id");
        if (userId && entry.id !== userId) throw notAllowed(`user "${userId}" may not update user "${entry.id}"`);
        const set = (entry.set ?? {}) as Record<string, unknown>;
        if (userId) {
          delete set.role;
          delete set.teams;
        }
        const user = chat.partialUpdateUser(entry.id, set, stringArrayField(entry, "unset"));
        result[user.user_id] = chat.formatUser(user, hub.isOnline(user.user_id));
      }
      return { users: result };
    }),
  );

  // queryUsers: GET /users?payload={ filter_conditions, sort, limit, offset }
  app.get(
    "/users",
    streamHandler(store, (request, c) => {
      const { chat, hub, userId } = request;
      let payload: Record<string, unknown> = {};
      const raw = c.req.query("payload");
      if (raw) {
        try {
          payload = JSON.parse(raw);
        } catch {
          throw inputError("payload is not valid JSON");
        }
      }
      const viewerTeams = userId ? (chat.findUser(userId)?.teams ?? []) : null;
      const limit = Math.max(1, Math.min(Number(payload.limit ?? 30), 100));
      const offset = Math.max(0, Number(payload.offset ?? 0));
      const sort = normalizeSort(payload.sort);
      const users = chat.db.users
        .all()
        .filter(
          (user) => !viewerTeams || viewerTeams.length === 0 || user.teams.some((team) => viewerTeams.includes(team)),
        )
        .map((user) => ({ user, doc: chat.userDocument(user) }))
        .filter(({ doc }) => matchesFilter(doc, payload.filter_conditions ?? {}))
        .sort((a, b) => compareBySort(a.doc, b.doc, sort) || a.user.id - b.user.id)
        .slice(offset, offset + limit)
        .map(({ user }) => chat.formatUser(user, hub.isOnline(user.user_id)));
      return { users };
    }),
  );

  // getAppSettings
  app.get(
    "/app",
    streamHandler(store, (request) => {
      const { chat } = request;
      const upload = {
        allowed_file_extensions: [],
        blocked_file_extensions: [],
        allowed_mime_types: [],
        blocked_mime_types: [],
        size_limit: 0,
      };
      return {
        app: {
          name: "emulate",
          organization: "emulate",
          multi_tenant_enabled: true,
          permission_version: "v2",
          webhook_url: chat.app.webhookUrl ?? "",
          file_upload_config: upload,
          image_upload_config: upload,
          channel_configs: {},
          disable_auth_checks: false,
          disable_permissions_checks: false,
        },
      };
    }),
  );

  // updateAppSettings: only webhook_url is emulated
  app.patch(
    "/app",
    streamHandler(store, (request) => {
      if (request.principal.kind !== "server") throw notAllowed("app settings need a server token");
      const { webhook_url: webhookUrl } = request.body;
      if (webhookUrl !== undefined) {
        if (typeof webhookUrl !== "string") throw inputError("webhook_url must be a string");
        setAppConfig(store, { webhookUrl: webhookUrl.length > 0 ? webhookUrl : null });
      }
      return {};
    }),
  );

  // sync: the events a reconnecting client missed. Only message.new is replayed.
  app.post(
    "/sync",
    streamHandler(store, (request) => {
      const { chat, hub, body, userId } = request;
      const since = typeof body.last_sync_at === "string" ? Date.parse(body.last_sync_at) : NaN;
      if (Number.isNaN(since)) throw inputError("last_sync_at is required");
      const cids = stringArrayField(body, "channel_cids");
      const events = cids.flatMap((cid) => {
        const channel = chat.db.channels.findOneBy("cid", cid);
        if (!channel || (userId && !chat.canAccess(userId, channel))) return [];
        return chat
          .messages(cid)
          .filter((message) => Date.parse(message.created_at) > since)
          .map((message) => ({
            type: "message.new",
            cid,
            channel_id: channel.channel_id,
            channel_type: channel.type,
            message: chat.formatMessage(message, hub.isOnline),
            user: chat.formatUserId(message.user_id),
            created_at: message.created_at,
          }));
      });
      return { events };
    }),
  );
}
