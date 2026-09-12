# @emulators/microsoft

Microsoft Entra ID (Azure AD) v2.0 OAuth 2.0 and OpenID Connect emulation with authorization code flow, PKCE, client credentials, RS256 ID tokens, and OIDC discovery.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/microsoft
```

## Endpoints

- `GET /.well-known/openid-configuration` — OIDC discovery document
- `GET /:tenant/v2.0/.well-known/openid-configuration` — tenant-scoped OIDC discovery
- `GET /discovery/v2.0/keys` — JSON Web Key Set (JWKS)
- `GET /oauth2/v2.0/authorize` — authorization endpoint (shows user picker)
- `POST /oauth2/v2.0/token` — token exchange (authorization code, refresh token, client credentials)
- `GET /oidc/userinfo` — OpenID Connect user info
- `GET /v1.0/me` — Microsoft Graph user profile
- `GET /v1.0/users/:id` — Microsoft Graph user by ID
- `GET /oauth2/v2.0/logout` — end session / logout
- `POST /oauth2/v2.0/revoke` — token revocation

## Auth

OIDC authorization code flow with PKCE support. Also supports client credentials grants. Microsoft Graph `/v1.0/me` available.

## Seed Configuration

```yaml
microsoft:
  users:
    - email: testuser@outlook.com
      name: Test User
  oauth_clients:
    - client_id: example-client-id
      client_secret: example-client-secret
      name: My Microsoft App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/microsoft-entra-id
```

## Links

- [Full documentation](https://emulate.dev/microsoft)
- [GitHub](https://github.com/vercel-labs/emulate)

## Teams messaging

Teams uses two boundaries: Graph discovers the installed app and chat, while Bot Framework Connector delivers messages. Set the Graph base URL, Connector `baseUri` (or conversation reference `serviceUrl`), and OAuth token URL to the emulator. Redirecting Graph alone does not redirect bot messages. The Connector SDK token acquisition can use a local token provider; the test suite exercises SDK serialization and error decoding with an in-process HTTP transport.

Seed `microsoft.users` with an optional stable `oid`, `oauth_clients` with a bot client ID and secret, and these collections:

```yaml
microsoft:
  users:
    - email: reader@example.com
      oid: user-1
  oauth_clients:
    - client_id: bot-1
      client_secret: local-secret
      name: Example Bot
      redirect_uris: []
  teams_conversations:
    - conversation_id: chat-1
      bot_id: bot-1
      tenant_id: tenant-1
      members: [{ id: user-1 }]
      is_group: false
  teams_installations:
    - installation_id: install-1
      user_id: user-1
      app_id: app-1
      external_id: external-app-1
      conversation_id: chat-1
```

Mint separate client-credentials bearer tokens at `POST /oauth2/v2.0/token` or `POST /{tenant}/oauth2/v2.0/token` (including tenant `botframework.com`): use `scope=https://graph.microsoft.com/.default` for discovery and `scope=https://api.botframework.com/.default` for Connector and read-back. Configure OAuth clients to validate client secrets. New routes reject missing or unknown bearer tokens (401) and wrong scopes (403); bot access also requires the token client ID to match the conversation's `bot_id`.

Supported routes:

- `GET /v1.0/users`: optional `$filter=mail eq 'reader@example.com'` and `$select`.
- `GET /v1.0/organization`: organizations derived from seeded user tenant IDs.
- `GET /v1.0/users/{userId}/teamwork/installedApps`: optional `teamsApp/id eq 'app-1'` or `teamsApp/externalId eq 'external-app-1'` filter.
- `GET /v1.0/users/{userId}/teamwork/installedApps/{installationId}/chat`.
- `POST /v3/conversations`: create a conversation with `bot`, `members`, optional `tenantId`, `channelData.tenant.id`, `isGroup`, and initial `activity`.
- `POST /v3/conversations/{conversationId}/activities`: send a message.
- `POST /v3/conversations/{conversationId}/activities/{activityId}`: reply to a stored message.
- `PUT /v3/conversations/{conversationId}/activities/{activityId}`: replace a message or card, retaining its ID.
- `DELETE /v3/conversations/{conversationId}/activities/{activityId}`: delete a message.
- `GET /_emulator/teams/conversations/{conversationId}/activities`: emulator-only read-back in original send order; returns `{ "activities": [...] }`. This is not a Microsoft Connector history endpoint.

Messages require `type: message` and text or attachments. Adaptive Cards, hero cards, card actions, attachment URLs, and channel data retain their JSON payloads. Cards are stored, not rendered or executed. Bad message bodies return `BadArgument` (400); absent conversations return `ConversationNotFound` (404); missing activities return `MessageNotFound` (404). Seed `blocked: true` on a conversation to produce `BotNotInConversationRoster` (403). Failed writes do not create messages. State uses the shared store and participates in snapshots and reset.

Limitations: no Graph chat-message sending, incoming webhooks, inbound bot events, card callbacks, Teams installation writes, pagination, throttling, attachment downloads, or full card-schema validation. Graph discovery uses the Graph `.default` scope and is not a tenant/permission-consent simulator. Existing emulator token expiry and permissive unconfigured-client behavior are unchanged. Use configured clients for authentication tests.
