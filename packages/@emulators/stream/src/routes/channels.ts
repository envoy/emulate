import type { RouteContext } from "@emulators/core";
import type { MessageInput, MessagePageOptions, StreamChatApp } from "../chat.js";
import type { StreamChannel } from "../entities.js";
import { inputError, notAllowed } from "../errors.js";
import {
  publishChannelEvent,
  publishChannelUpdated,
  publishMembersAdded,
  publishMembersRemoved,
  publishMessageNew,
  publishRead,
  readEvent,
} from "../events.js";
import { compareBySort, matchesFilter, normalizeSort } from "../filters.js";
import { actingUser, objectField, streamHandler, stringArrayField, type StreamRequest } from "../request.js";

const TYPING_EVENTS = new Set(["typing.start", "typing.stop"]);

/** Register the watch, but only for a connection the requesting user owns. */
function watchIfAsked(request: StreamRequest, channel: StreamChannel): void {
  if (request.body.watch !== true || !request.userId) return;
  const connection = request.hub.connection(request.connectionId);
  if (connection && connection.userId === request.userId) request.hub.watch(connection.id, channel.cid);
}

function guard(request: StreamRequest, channel: StreamChannel): void {
  if (request.userId) request.chat.requireAccess(request.userId, channel);
}

function messagePageOptions(value: unknown): MessagePageOptions {
  if (!value || typeof value !== "object") return {};
  const options = value as Record<string, unknown>;
  const pick = (key: string) => (typeof options[key] === "string" ? (options[key] as string) : undefined);
  return {
    limit: typeof options.limit === "number" ? options.limit : undefined,
    id_lt: pick("id_lt"),
    id_lte: pick("id_lte"),
    id_gt: pick("id_gt"),
    id_gte: pick("id_gte"),
  };
}

function state(request: StreamRequest, channel: StreamChannel, options: MessagePageOptions) {
  const { chat, hub } = request;
  return chat.formatChannelState(
    channel,
    actingUser(request),
    hub.isOnline,
    hub.watcherCount(channel.cid),
    chat.messagePage(channel.cid, options),
  );
}

function membersOf(chat: StreamChatApp, channel: StreamChannel, isOnline: (userId: string) => boolean) {
  return chat.members(channel.cid).map((member) => chat.formatMember(member, isOnline));
}

export function channelRoutes({ app, store }: RouteContext): void {
  // queryChannels
  app.post(
    "/channels",
    streamHandler(store, (request) => {
      const { chat, body } = request;
      const viewer = actingUser(request);
      const limit = Math.max(1, Math.min(Number(body.limit ?? 10), 30));
      const offset = Math.max(0, Number(body.offset ?? 0));
      const messageLimit = Math.max(0, Math.min(Number(body.message_limit ?? 25), 300));
      const sort = normalizeSort(body.sort);
      const order = sort.length > 0 ? sort : [{ field: "last_updated", direction: -1 }];

      const matched = chat.db.channels
        .all()
        .filter((channel) => !viewer || chat.canAccess(viewer, channel))
        .map((channel) => ({ channel, doc: chat.channelDocument(channel) }))
        .filter(({ doc }) => matchesFilter(doc, body.filter_conditions ?? {}))
        .sort((a, b) => compareBySort(a.doc, b.doc, order) || b.channel.id - a.channel.id)
        .slice(offset, offset + limit)
        .map(({ channel }) => channel);

      for (const channel of matched) watchIfAsked(request, channel);
      return { channels: matched.map((channel) => state(request, channel, { limit: messageLimit })) };
    }),
  );

  // getOrCreate / watch / query one channel
  app.post(
    "/channels/:type/:id/query",
    streamHandler(store, (request, c) => {
      const { chat, hub, body } = request;
      const data = objectField(body, "data");
      const actor = actingUser(request);
      const existing = chat.findChannel(c.req.param("type"), c.req.param("id"));
      if (existing) guard(request, existing);
      else if (request.userId && typeof data?.team === "string" && data.team.length > 0) {
        // A client may create a channel only in a team it belongs to.
        if (!chat.findUser(request.userId)?.teams.includes(data.team)) {
          throw notAllowed(`user "${request.userId}" cannot create a channel in team "${data.team}"`);
        }
      }
      const { channel, created, addedMembers } = chat.getOrCreateChannel(
        c.req.param("type"),
        c.req.param("id"),
        data,
        actor,
      );
      if (created) publishMembersAdded(chat, hub, channel, addedMembers);
      watchIfAsked(request, channel);
      return state(request, channel, messagePageOptions(body.messages));
    }),
  );

  // update: add/remove members, replace data, optional accompanying message
  app.post(
    "/channels/:type/:id",
    streamHandler(store, (request, c) => {
      const { chat, hub, body } = request;
      let channel = chat.requireChannel(c.req.param("type"), c.req.param("id"));
      guard(request, channel);
      const actor = actingUser(request);

      const added = chat.addMembers(channel, chat.memberIdsOf(body.add_members));
      publishMembersAdded(chat, hub, channel, added);
      const removed = chat.removeMembers(channel, chat.memberIdsOf(body.remove_members));
      publishMembersRemoved(chat, hub, channel, removed);

      const data = objectField(body, "data");
      if (data) {
        channel = chat.replaceChannelData(channel, data);
        publishChannelUpdated(chat, hub, channel, actor);
      }

      let message: Record<string, unknown> | undefined;
      const messageInput = objectField(body, "message");
      if (messageInput) {
        const sender = actingUser(request, messageInput);
        if (!sender) throw inputError("message.user_id is required for server-side requests");
        const sent = chat.sendMessage(channel, sender, messageInput as MessageInput, { server: !request.userId });
        channel = chat.requireChannel(channel.type, channel.channel_id);
        publishMessageNew(chat, hub, channel, sent);
        message = chat.formatMessage(sent, hub.isOnline);
      }

      channel = chat.requireChannel(channel.type, channel.channel_id);
      return {
        channel: chat.formatChannel(channel, hub.isOnline),
        members: membersOf(chat, channel, hub.isOnline),
        ...(message ? { message } : {}),
      };
    }),
  );

  // partial update: set / unset
  app.patch(
    "/channels/:type/:id",
    streamHandler(store, (request, c) => {
      const { chat, hub, body } = request;
      const channel = chat.requireChannel(c.req.param("type"), c.req.param("id"));
      guard(request, channel);
      const updated = chat.partialUpdateChannel(channel, objectField(body, "set"), stringArrayField(body, "unset"));
      publishChannelUpdated(chat, hub, updated, actingUser(request));
      return {
        channel: chat.formatChannel(updated, hub.isOnline),
        members: membersOf(chat, updated, hub.isOnline),
      };
    }),
  );

  // sendMessage
  app.post(
    "/channels/:type/:id/message",
    streamHandler(store, (request, c) => {
      const { chat, hub, body } = request;
      const channel = chat.requireChannel(c.req.param("type"), c.req.param("id"));
      guard(request, channel);
      const input = objectField(body, "message");
      if (!input) throw inputError("message is a required field");
      const sender = actingUser(request, input);
      if (!sender) throw inputError("message.user_id or message.user.id is required for server-side requests");
      const message = chat.sendMessage(channel, sender, input as MessageInput, { server: !request.userId });
      publishMessageNew(chat, hub, chat.requireChannel(channel.type, channel.channel_id), message);
      return { message: chat.formatMessage(message, hub.isOnline) };
    }),
  );

  // getMessagesById
  app.get(
    "/channels/:type/:id/messages",
    streamHandler(store, (request, c) => {
      const { chat, hub } = request;
      const channel = chat.requireChannel(c.req.param("type"), c.req.param("id"));
      guard(request, channel);
      const ids = new Set((c.req.query("ids") ?? "").split(",").filter(Boolean));
      return {
        messages: chat
          .messages(channel.cid)
          .filter((message) => ids.has(message.message_id))
          .map((message) => chat.formatMessage(message, hub.isOnline)),
      };
    }),
  );

  // markRead
  app.post(
    "/channels/:type/:id/read",
    streamHandler(store, (request, c) => {
      const { chat, hub, body } = request;
      const channel = chat.requireChannel(c.req.param("type"), c.req.param("id"));
      guard(request, channel);
      const reader = actingUser(request);
      if (!reader) throw inputError("user_id is required for server-side requests");
      const messageId = typeof body.message_id === "string" ? body.message_id : undefined;
      const read = chat.markRead(channel, reader, messageId);
      if (!read) return { event: null };
      publishRead(chat, hub, channel, read);
      return { event: readEvent(chat, hub, channel, read) };
    }),
  );

  // sendEvent: typing indicators only
  app.post(
    "/channels/:type/:id/event",
    streamHandler(store, (request, c) => {
      const { chat, hub, body } = request;
      const channel = chat.requireChannel(c.req.param("type"), c.req.param("id"));
      guard(request, channel);
      const event = objectField(body, "event");
      if (!event || typeof event.type !== "string") throw inputError("event.type is a required field");
      if (!TYPING_EVENTS.has(event.type)) {
        throw notAllowed(`custom event "${event.type}" is not enabled for channel type "${channel.type}"`);
      }
      const sender = actingUser(request, event);
      if (!sender) throw inputError("user_id is required for server-side requests");
      return { event: publishChannelEvent(chat, hub, channel, sender, event) };
    }),
  );

  // stopWatching
  app.post(
    "/channels/:type/:id/stop-watching",
    streamHandler(store, (request, c) => {
      const channel = request.chat.requireChannel(c.req.param("type"), c.req.param("id"));
      const connection = request.hub.connection(request.connectionId);
      if (connection && connection.userId === request.userId) request.hub.unwatch(connection.id, channel.cid);
      return {};
    }),
  );
}
