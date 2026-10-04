---
name: stream
description: Emulated Stream Chat (getstream.io) REST API and WebSocket for local development and testing. Use when the user needs to test a Stream Chat integration without the real Stream service, emulate channels, members, messages, read state, typing events, queryChannels filters, stream-chat or stream-chat-react clients, stream-chat-java servers, or Stream webhooks. Triggers include "Stream Chat", "getstream", "stream-chat", "emulate Stream", "mock Stream chat", or any task requiring a local Stream Chat API.
allowed-tools: Bash(npx @envoy/emulate:*)
---

# Stream Chat Emulator

## Start

```bash
npx @envoy/emulate --service stream
```

Default URL: `http://localhost:4016` when all services are started, or `http://localhost:4000` when Stream is the only service. REST and the WebSocket share the port.

Stateful Stream Chat emulation for a server SDK and a browser client together: users, channels, members, messages, read state, typing events, MongoDB-style channel queries, the realtime WebSocket, and signed `message.new` webhooks. It covers the surface a server that creates channels and a `stream-chat-react` UI that lists, opens, and replies to them actually use.

## Credentials

Every REST request carries the API key as the `api_key` query parameter and an HS256 JWT in `Authorization` (no scheme) with `stream-auth-type: jwt`, exactly as the Stream SDKs send them. A server token carries `server: true`; a user token carries `user_id`. Tokens must be signed with the configured secret; `exp` is enforced, and an expired token returns Stream's code `40`.

```text
STREAM_API_KEY=emulate_stream_key
STREAM_API_SECRET=emulate_stream_secret_0123456789abcdefghijklmnop
```

The secret must be at least 32 bytes. stream-chat-java signs with jjwt, which refuses a shorter HS256 key.

## Pointing the SDKs at the emulator

| Client | Setting |
|--------|---------|
| `stream-chat` (JS, browser or Node) | `new StreamChat(key, { baseURL: "http://localhost:4000" })`; the WebSocket URL follows (`ws://localhost:4000/connect`) |
| `stream-chat` server-side | `new StreamChat(key, secret, { baseURL })` |
| `stream-chat-java` | the `STREAM_CHAT_URL` environment variable, or the `io.getstream.chat.url` property |

A browser bundle that cannot be configured dials `https://chat.stream-io-api.com` and `wss://chat.stream-io-api.com/connect`. Route that host to the emulator with a proxy that terminates TLS and forwards plain HTTP with the `Host` header and WebSocket upgrade unchanged; the emulator serves REST and the WebSocket on the same port.

## Endpoints

- `POST /users` - upsert users keyed by id (`name`, `role`, `teams`, custom fields)
- `PATCH /users` - partial user update (`set`, `unset`)
- `GET /users?payload=...` - query users
- `POST /channels` - query channels with `filter_conditions`, `sort`, `limit`, `offset`, `message_limit`, `watch`
- `POST /channels/{type}/{id}/query` - get or create a channel (`data.created_by`, `data.members`, `data.team`, custom fields), watch it, page messages (`messages.limit`, `id_lt`, `id_gt`)
- `POST /channels/{type}/{id}` - `add_members`, `remove_members`, replace `data`, optional accompanying `message`
- `PATCH /channels/{type}/{id}` - partial channel update, including `frozen`
- `POST /channels/{type}/{id}/message` - send a message (`regular`, or `system` from a server token)
- `GET /channels/{type}/{id}/messages?ids=...` - get messages by id
- `POST /channels/{type}/{id}/read` - mark read
- `POST /channels/{type}/{id}/event` - `typing.start` and `typing.stop`
- `POST /channels/{type}/{id}/stop-watching` - stop watching
- `GET /app`, `PATCH /app` (`webhook_url` only), `POST /sync`
- `GET /connect` (WebSocket) - handshake answered with a `health.check` event carrying `connection_id` and `me`; client `health.check` frames are answered; watchers receive `message.new`, `member.added`, `member.removed`, `channel.updated`, `message.read`, `typing.start`, and `typing.stop`; connected members who are not watching receive `notification.message_new`, `notification.added_to_channel`, and `notification.mark_read`

Filters support equality, `$eq`, `$ne`, `$in`, `$nin`, `$exists`, `$gt`, `$gte`, `$lt`, `$lte`, `$contains`, `$autocomplete`, `$q`, `$and`, `$or`, and `$nor`, against built-in fields (`type`, `id`, `cid`, `team`, `members`, `frozen`, `created_by_id`, `last_message_at`, `created_at`, `updated_at`, `member_count`) and custom channel fields. Equality is type-sensitive, as in Stream. Teams are enforced: a client sees a channel with a `team` only when its user belongs to that team.

## Webhooks

Set `stream.webhook_url` (or `PATCH /app` with `webhook_url`) to receive `message.new` for every sent message. The body carries `type`, `cid`, `channel_id`, `channel_type`, `message`, `user`, `members`, and `created_at`; `X-Signature` is the hex HMAC-SHA256 of the raw body with the API secret.

## Seed config

```yaml
stream:
  api_key: emulate_stream_key
  api_secret: emulate_stream_secret_0123456789abcdefghijklmnop
  webhook_url: http://localhost:3000/api/stream/webhook
  users:
    - id: admin
      name: Admin
      teams: [team-1]
  channels:
    - type: messaging
      id: general
      team: team-1
      created_by_id: admin
      members: [admin]
      data:
        name: General
      messages:
        - user_id: admin
          text: Hello from the Stream emulator
```

## Inspection

- `GET /` - tabbed inspector for channels, messages, users, WebSocket connections, and webhook deliveries
- `GET /_emulate/stream/channels`, `GET /_emulate/stream/channels/{type}/{id}/messages`, `GET /_emulate/stream/users`, `GET /_emulate/stream/connections`, `GET /_emulate/stream/webhooks` - JSON read-back
- `POST /_emulate/stream/tokens` with `{ "user_id": "..." }` - mint a user token with the app secret, for a test that plays another chat participant

## Embedding

`@envoy/emulators-stream` exports `attachStreamWebSocket(server, store)` for a Node HTTP server and `createStreamBunWebSocket(store)` for `Bun.serve`, plus `createUserToken` and `createServerToken`. The CLI attaches the WebSocket automatically.

Current Stream limits: no reactions, threads and replies, attachments or uploads, polls, pinned messages, moderation, push, custom events, channel type configuration, roles and permission policies beyond team scoping, message editing or deletion, or presence events. Every channel type uses one fixed configuration with typing and read events on.
