import type { InspectorTab, RouteContext } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { createUserToken } from "../auth.js";
import { StreamChatApp } from "../chat.js";
import { getStreamHub } from "../realtime.js";

const SERVICE_LABEL = "Stream";
const TABS: InspectorTab[] = [
  { id: "channels", label: "Channels", href: "/?tab=channels" },
  { id: "messages", label: "Messages", href: "/?tab=messages" },
  { id: "users", label: "Users", href: "/?tab=users" },
  { id: "connections", label: "Connections", href: "/?tab=connections" },
  { id: "webhooks", label: "Webhooks", href: "/?tab=webhooks" },
];

/**
 * The inspector page at `/` and the read-back routes under `/_emulate/stream`. Neither
 * is part of Stream's API; they let a person or a test see what the emulator holds.
 */
export function inspectorRoutes({ app, store }: RouteContext): void {
  const chat = () => new StreamChatApp(store);

  app.get("/", (c) => {
    const requested = c.req.query("tab") ?? "channels";
    const active = TABS.some((tab) => tab.id === requested) ? requested : "channels";
    const views: Record<string, () => string> = {
      channels: channelsView,
      messages: messagesView,
      users: usersView,
      connections: connectionsView,
      webhooks: webhooksView,
    };
    return c.html(renderInspectorPage("Stream Chat Inspector", TABS, active, views[active](), SERVICE_LABEL));
  });

  function channelsView(): string {
    const s = chat();
    const rows = s.db.channels
      .all()
      .sort((a, b) => b.id - a.id)
      .map((channel) => [
        escapeHtml(channel.cid),
        escapeHtml(channel.team ?? ""),
        escapeHtml(String(channel.custom.name ?? "")),
        escapeHtml(
          s
            .members(channel.cid)
            .map((member) => member.user_id)
            .join(", "),
        ),
        escapeHtml(String(s.messages(channel.cid).length)),
        escapeHtml(channel.frozen ? "yes" : "no"),
        escapeHtml(channel.last_message_at ?? ""),
      ]);
    return section(
      "Channels",
      table(["CID", "Team", "Name", "Members", "Messages", "Frozen", "Last message"], rows, "No channels."),
    );
  }

  function messagesView(): string {
    const rows = chat()
      .db.messages.all()
      .sort((a, b) => b.id - a.id)
      .map((message) => [
        escapeHtml(message.cid),
        escapeHtml(message.user_id),
        escapeHtml(message.type),
        escapeHtml(message.text),
        escapeHtml(message.created_at),
      ]);
    return section("Messages", table(["Channel", "User", "Type", "Text", "Created"], rows, "No messages."));
  }

  function usersView(): string {
    const hub = getStreamHub(store);
    const rows = chat()
      .db.users.all()
      .map((user) => [
        escapeHtml(user.user_id),
        escapeHtml(user.name ?? ""),
        escapeHtml(user.role),
        escapeHtml(user.teams.join(", ")),
        escapeHtml(hub.isOnline(user.user_id) ? "online" : "offline"),
      ]);
    return section("Users", table(["ID", "Name", "Role", "Teams", "Presence"], rows, "No users."));
  }

  function connectionsView(): string {
    const rows = getStreamHub(store)
      .stats()
      .map((connection) => [
        escapeHtml(connection.connection_id),
        escapeHtml(connection.user_id),
        escapeHtml(connection.watching.join(", ")),
      ]);
    return section("Connections", table(["Connection", "User", "Watching"], rows, "No WebSocket connections."));
  }

  function webhooksView(): string {
    const s = chat();
    const rows = s.db.webhookDeliveries
      .all()
      .sort((a, b) => b.id - a.id)
      .map((delivery) => [
        escapeHtml(delivery.event_type),
        escapeHtml(delivery.cid ?? ""),
        escapeHtml(delivery.url),
        escapeHtml(delivery.status_code === null ? "" : String(delivery.status_code)),
        escapeHtml(delivery.error ?? ""),
      ]);
    const configured = s.app.webhookUrl
      ? `<p>Webhook URL: <code>${escapeHtml(s.app.webhookUrl)}</code></p>`
      : `<p class="inspector-empty">No webhook URL configured.</p>`;
    return section(
      "Webhooks",
      configured + table(["Event", "Channel", "URL", "Status", "Error"], rows, "No webhook deliveries."),
    );
  }

  // JSON read-back

  app.get("/_emulate/stream/channels", (c) => {
    const s = chat();
    const hub = getStreamHub(store);
    return c.json({
      channels: s.db.channels.all().map((channel) => ({
        ...s.formatChannel(channel, hub.isOnline),
        members: s.members(channel.cid).map((member) => member.user_id),
        message_count: s.messages(channel.cid).length,
        watcher_count: hub.watcherCount(channel.cid),
      })),
    });
  });

  app.get("/_emulate/stream/channels/:type/:id/messages", (c) => {
    const s = chat();
    const hub = getStreamHub(store);
    const channel = s.findChannel(c.req.param("type"), c.req.param("id"));
    if (!channel) return c.json({ message: "channel not found" }, 404);
    return c.json({ messages: s.messages(channel.cid).map((message) => s.formatMessage(message, hub.isOnline)) });
  });

  app.get("/_emulate/stream/users", (c) => {
    const s = chat();
    const hub = getStreamHub(store);
    return c.json({ users: s.db.users.all().map((user) => s.formatUser(user, hub.isOnline(user.user_id))) });
  });

  app.get("/_emulate/stream/connections", (c) => c.json({ connections: getStreamHub(store).stats() }));

  app.get("/_emulate/stream/webhooks", (c) =>
    c.json({
      deliveries: chat()
        .db.webhookDeliveries.all()
        .map((delivery) => ({
          event_type: delivery.event_type,
          cid: delivery.cid,
          url: delivery.url,
          status_code: delivery.status_code,
          error: delivery.error,
          payload: JSON.parse(delivery.payload),
          created_at: delivery.created_at,
        })),
    }),
  );

  /** Mint a user token with the app secret, for a test that plays a chat participant. */
  app.post("/_emulate/stream/tokens", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { user_id?: unknown; expires_in?: unknown };
    if (typeof body.user_id !== "string" || body.user_id.length === 0) {
      return c.json({ message: "user_id is required" }, 400);
    }
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : undefined;
    return c.json({ user_id: body.user_id, token: createUserToken(chat().app.apiSecret, body.user_id, expiresIn) });
  });
}

function section(title: string, body: string): string {
  return `<section class="inspector-section">
  <h2>${escapeHtml(title)}</h2>
  ${body}
</section>`;
}

function table(headers: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return `<p class="inspector-empty">${escapeHtml(empty)}</p>`;
  const headerHtml = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const rowHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("\n");
  return `<table class="inspector-table">
  <thead><tr>${headerHtml}</tr></thead>
  <tbody>
${rowHtml}
  </tbody>
</table>`;
}
