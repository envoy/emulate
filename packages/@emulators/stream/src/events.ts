import { createHmac, randomUUID } from "node:crypto";
import type { StreamChatApp } from "./chat.js";
import type { StreamChannel, StreamMember, StreamMessage, StreamRead } from "./entities.js";
import type { StreamEvent, StreamHub } from "./realtime.js";

/**
 * Events a REST mutation pushes to WebSocket clients, and the webhook Stream would
 * POST to the app's configured URL.
 *
 * Watchers of a channel get channel events (`message.new`, `member.added`,
 * `channel.updated`, `message.read`, `typing.*`). A member who is connected but not
 * watching gets the `notification.*` form instead, which carries the channel.
 */

function channelFields(channel: StreamChannel): Record<string, unknown> {
  return {
    cid: channel.cid,
    channel_id: channel.channel_id,
    channel_type: channel.type,
    ...(channel.team ? { team: channel.team } : {}),
  };
}

export function publishMessageNew(chat: StreamChatApp, hub: StreamHub, channel: StreamChannel, message: StreamMessage) {
  const createdAt = message.created_at;
  const formatted = chat.formatMessage(message, hub.isOnline);
  const user = chat.formatUserId(message.user_id, hub.isOnline(message.user_id));
  const watcherCount = hub.watcherCount(channel.cid);

  for (const connection of hub.watchers(channel.cid)) {
    const read = chat.findRead(channel.cid, connection.userId);
    hub.send(connection, {
      type: "message.new",
      ...channelFields(channel),
      message_id: message.message_id,
      message: formatted,
      user,
      watcher_count: watcherCount,
      channel_last_message_at: createdAt,
      created_at: createdAt,
      ...chat.unreadCounts(connection.userId),
      ...(read ? { unread_count: read.unread_messages } : {}),
    });
  }

  const memberIds = chat.members(channel.cid).map((member) => member.user_id);
  for (const connection of hub.nonWatchingConnections(memberIds, channel.cid)) {
    hub.send(connection, {
      type: "notification.message_new",
      ...channelFields(channel),
      channel: chat.formatChannel(channel, hub.isOnline),
      message: formatted,
      created_at: createdAt,
      ...chat.unreadCounts(connection.userId),
    });
  }

  deliverWebhook(chat, {
    type: "message.new",
    ...channelFields(channel),
    message_id: message.message_id,
    message: formatted,
    user,
    members: chat.members(channel.cid).map((member) => chat.formatMember(member, hub.isOnline)),
    watcher_count: watcherCount,
    created_at: createdAt,
  });
}

export function publishMembersAdded(
  chat: StreamChatApp,
  hub: StreamHub,
  channel: StreamChannel,
  members: StreamMember[],
) {
  const createdAt = new Date().toISOString();
  for (const member of members) {
    const formatted = chat.formatMember(member, hub.isOnline);
    broadcast(hub, channel, {
      type: "member.added",
      ...channelFields(channel),
      member: formatted,
      user: formatted.user,
      created_at: createdAt,
    });
    for (const connection of hub.nonWatchingConnections([member.user_id], channel.cid)) {
      hub.send(connection, {
        type: "notification.added_to_channel",
        ...channelFields(channel),
        channel: chat.formatChannel(channel, hub.isOnline),
        member: formatted,
        created_at: createdAt,
        ...chat.unreadCounts(connection.userId),
      });
    }
  }
}

export function publishMembersRemoved(
  chat: StreamChatApp,
  hub: StreamHub,
  channel: StreamChannel,
  members: StreamMember[],
) {
  const createdAt = new Date().toISOString();
  for (const member of members) {
    broadcast(hub, channel, {
      type: "member.removed",
      ...channelFields(channel),
      user: chat.formatUserId(member.user_id, hub.isOnline(member.user_id)),
      created_at: createdAt,
    });
  }
}

export function publishChannelUpdated(
  chat: StreamChatApp,
  hub: StreamHub,
  channel: StreamChannel,
  actorId: string | null,
) {
  broadcast(hub, channel, {
    type: "channel.updated",
    ...channelFields(channel),
    channel: chat.formatChannel(channel, hub.isOnline),
    ...(actorId ? { user: chat.formatUserId(actorId, hub.isOnline(actorId)) } : {}),
    created_at: new Date().toISOString(),
  });
}

export function readEvent(chat: StreamChatApp, hub: StreamHub, channel: StreamChannel, read: StreamRead): StreamEvent {
  return {
    type: "message.read",
    ...channelFields(channel),
    user: chat.formatUserId(read.user_id, hub.isOnline(read.user_id)),
    ...(read.last_read_message_id ? { last_read_message_id: read.last_read_message_id } : {}),
    created_at: read.last_read,
  };
}

export function publishRead(chat: StreamChatApp, hub: StreamHub, channel: StreamChannel, read: StreamRead) {
  broadcast(hub, channel, readEvent(chat, hub, channel, read));
  for (const connection of hub.connectionsOf(read.user_id)) {
    hub.send(connection, {
      type: "notification.mark_read",
      ...channelFields(channel),
      user: chat.formatUserId(read.user_id, true),
      unread_count: 0,
      ...chat.unreadCounts(read.user_id),
      created_at: read.last_read,
    });
  }
}

export function publishChannelEvent(
  chat: StreamChatApp,
  hub: StreamHub,
  channel: StreamChannel,
  userId: string,
  input: Record<string, unknown>,
): StreamEvent {
  const event: StreamEvent = {
    ...input,
    type: String(input.type),
    ...channelFields(channel),
    user: chat.formatUserId(userId, hub.isOnline(userId)),
    created_at: new Date().toISOString(),
  };
  broadcast(hub, channel, event);
  return event;
}

function broadcast(hub: StreamHub, channel: StreamChannel, event: StreamEvent) {
  for (const connection of hub.watchers(channel.cid)) hub.send(connection, event);
}

/**
 * POST the event to the configured webhook URL, signed as Stream signs it:
 * `X-Signature` is the hex HMAC-SHA256 of the raw body with the app secret.
 * Delivery is fire-and-forget; the outcome is recorded for the inspector.
 */
function deliverWebhook(chat: StreamChatApp, event: StreamEvent): void {
  const { webhookUrl, apiKey, apiSecret } = chat.app;
  if (!webhookUrl) return;
  const body = JSON.stringify(event);
  const delivery = chat.db.webhookDeliveries.insert({
    event_type: event.type,
    url: webhookUrl,
    cid: typeof event.cid === "string" ? event.cid : null,
    status_code: null,
    error: null,
    payload: body,
  });
  void fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature": createHmac("sha256", apiSecret).update(body).digest("hex"),
      "X-Api-Key": apiKey,
      "X-Webhook-Id": randomUUID(),
      "X-Webhook-Attempt": "1",
    },
    body,
    signal: AbortSignal.timeout(10_000),
  }).then(
    async (response) => {
      await response.body?.cancel().catch(() => {});
      chat.db.webhookDeliveries.update(delivery.id, { status_code: response.status });
    },
    (error: unknown) => {
      chat.db.webhookDeliveries.update(delivery.id, {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}
