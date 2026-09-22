# Changelog

## [0.13.0](https://github.com/envoy/emulate/compare/v0.12.0...v0.13.0) (2026-09-22)


### Features

* **chargebee:** emulate trials and saved payment sources ([#13](https://github.com/envoy/emulate/issues/13)) ([ffb4832](https://github.com/envoy/emulate/commit/ffb48321f8bab5e445882d3bd78678b58fe9de69))
* **cloudflare:** emulate Turnstile widget and token verification ([#15](https://github.com/envoy/emulate/issues/15)) ([5ce69f5](https://github.com/envoy/emulate/commit/5ce69f520e6f1fd130dcffdb8b143dd7708a78b1))
* **github:** support raw media negotiation for Contents and README ([#237](https://github.com/envoy/emulate/issues/237)) ([67d5d29](https://github.com/envoy/emulate/commit/67d5d2965f3c084df7b83c69fbf7fdca28e5d562))
* **google:** add Calendar v3 discovery endpoint ([#238](https://github.com/envoy/emulate/issues/238)) ([a0401aa](https://github.com/envoy/emulate/commit/a0401aa5ac7ef2530cc9e93b675ccc365b81025c))
* **resend:** support Idempotency-Key for email sends ([#239](https://github.com/envoy/emulate/issues/239)) ([f360ec7](https://github.com/envoy/emulate/commit/f360ec712b4d4f4febbb2a31050f8758b8c71008))
* **slack:** enforce 40,000-character message limit ([#244](https://github.com/envoy/emulate/issues/244)) ([01df562](https://github.com/envoy/emulate/commit/01df562070275107bcc7e69da7ce5afd91f66e30))
* **stripe:** emulate Elements card entry and single-use tokens ([#14](https://github.com/envoy/emulate/issues/14)) ([89bc99a](https://github.com/envoy/emulate/commit/89bc99a97e120b6bc3f46d03062cff6de2094223))


### Bug Fixes

* **aws:** preserve binary data in S3 objects ([#245](https://github.com/envoy/emulate/issues/245)) ([4924f9f](https://github.com/envoy/emulate/commit/4924f9f63b594694cc30a91514d44eca438e711f))
* **github:** authorize organization installation writes as App bots ([#242](https://github.com/envoy/emulate/issues/242)) ([fc14214](https://github.com/envoy/emulate/commit/fc14214eba678fd576cb0dee0646313efb847487))
* **github:** support slash-containing refs in Checks list endpoints ([#246](https://github.com/envoy/emulate/issues/246)) ([be9794f](https://github.com/envoy/emulate/commit/be9794f8e92e13d6d9b051623148dec761620381))
* **google:** support RS256 OIDC tokens and JWKS ([#247](https://github.com/envoy/emulate/issues/247)) ([35ddfa8](https://github.com/envoy/emulate/commit/35ddfa8224560e100d3f00846dfee4e1cefec816))
* **microsoft:** bind refresh tokens to OAuth clients ([#243](https://github.com/envoy/emulate/issues/243)) ([9672fe4](https://github.com/envoy/emulate/commit/9672fe46fcd105c19c765f6025ec99584b2bebce))
* **release:** sync upstream and preserve Envoy package distribution ([dc05edd](https://github.com/envoy/emulate/commit/dc05edd6a09f514cb3069f0440158ed4cc1b3b0f))
* **release:** sync upstream and preserve Envoy package distribution ([330bf3f](https://github.com/envoy/emulate/commit/330bf3f25bf7a87b4f872a087feb53e58b2a4fe2))


### Documentation

* align configuration examples with supported services ([#248](https://github.com/envoy/emulate/issues/248)) ([3d2a716](https://github.com/envoy/emulate/commit/3d2a7164b8868603294c4ef1843c624007203eb1))

## [0.12.0](https://github.com/envoy/emulate/compare/v0.11.0...v0.12.0) (2026-09-12)


### Features

* **release:** publish to GitHub Packages under the [@envoy](https://github.com/envoy) scope with Release Please ([#8](https://github.com/envoy/emulate/issues/8)) ([6fc470f](https://github.com/envoy/emulate/commit/6fc470f608b37c95ae98a31680ad2f77b336ab04))


### Bug Fixes

* **deps:** repair the lockfile two Dependabot merges left behind ([ff578a9](https://github.com/envoy/emulate/commit/ff578a9a1716c903d29ec04b25393d679e0ab904))
* **deps:** repair the lockfile two Dependabot merges left behind ([00a57e2](https://github.com/envoy/emulate/commit/00a57e29ca410bf339263c5dc5bd853079526dff))

## 0.11.0

### New Features

- **Persistent adapter runtime** shares state handling across the Next.js and Nuxt adapters, including atomic initialization and generated GitHub App key persistence across cold starts
- **Linear issue priority labels** expose the derived `priorityLabel` alongside numeric issue priority in queries and mutations
- **GitHub installation-token inspection** exposes secret-free metadata for minted App installation tokens, including permissions, repository access, expiry, and lifecycle status

### Contributors

- @ctate
- @Railly


## 0.10.0

### New Features

- **Expanded GitHub repository APIs** add stateful contents, README, commits, comparisons, raw file downloads, Git Data shapes, branch isolation, and commit-producing file writes (#191)
- **Generated GitHub App keys** let `createEmulator` generate RSA private keys for GitHub Apps that omit `private_key`, expose generated material through `generatedSecrets`, and preserve it across resets (#200)

### Bug Fixes

- Fixed **Stripe webhook signatures** to send Stripe-compatible `Stripe-Signature` headers over the raw request body (#198)
- Fixed **GitHub App JWT verification** for documented PKCS#1 keys and PKCS#8 keys by deriving public key material before verification (#199)

### Contributors

- @ctate
- @EfeDurmaz16
- @Railly
- @sidpalas

## 0.9.0

### New Features

- **Nuxt emulator adapter** — new `@emulators/adapter-nuxt` package for embedding emulators in Nuxt apps, with Nuxt server route handling, persistence, response rewriting, and Nitro tracing support (#188)
- **Nuxt embedded example** — added `examples/nuxt-embedded` demonstrating same-origin OAuth flows (GitHub + Google), a catch-all emulate server route, and cookie-based sessions (#188)

### Improvements

- **Nuxt docs and agent guidance** — documented Nuxt setup across the README, docs site, and agent skills (#188)

### Contributors

- @ctate

## 0.8.0

### New Features

- **Twilio emulator** — local Twilio API emulation with accounts, phone numbers, messages, calls, conversations, messaging services, Verify flows, simulator endpoints, SDK conformance tests, and inspector support (#185)
- **Twilio SMS verification example** — working Next.js example for SMS verification with the Twilio emulator and local session handling (#186)

### Improvements

- **Twilio docs and agent guidance** — added README, docs site, and skill coverage for local Twilio development (#185, #186)

### Contributors

- @ctate

## 0.7.0

### New Features

- **Linear emulator** — stateful Linear GraphQL API emulation with seeded organizations, users, teams, workflow states, issues, comments, labels, projects, cycles, OAuth apps, tokens, webhooks, agent sessions, and local inspector support (#180)

### Improvements

- **Linear docs and agent guidance** — added README, docs site, programmatic API, and skill coverage for Linear API, OAuth, and webhook testing (#180)

### Contributors

- @ctate

## 0.6.1

### New Features

- **Vercel Blob emulator** — local emulation for Vercel Blob store operations, including uploads, downloads, listings, deletes, copy support, and inspector visibility (#175)

### Improvements

- **Vercel Blob examples** — added and hardened an example app that exercises upload sharing URL handling

### Contributors

- @ctate

## 0.6.0

### New Features

- **Expanded Slack emulator support** — stateful Slack writes for rich chat messages, updates, deletes, permalinks, ephemeral and scheduled messages, conversations and DMs, OAuth installs and scopes, user profiles and presence, modern file uploads, pins and bookmarks, App Home views, modals, inspector tabs, event delivery visibility, docs, and coverage matrix (#152-#164)

### Improvements

- **Slack SDK coverage** — added Slack WebClient conformance tests and route coverage for the supported Slack Web API surface (#152-#164)
- **Slack docs** — audited README, package docs, web docs, skill guidance, CLI seed output, strict scope notes, and unsupported Slack families against the implemented surface (#164)

### Contributors

- @ctate

## 0.5.0

### New Features

- **Clerk emulator** — local emulation of Clerk authentication and session management (#38)
- **Portless integration** — embed emulators directly in your app without dedicated ports, with base URL override support (#78)
- **Google `hd` claim** — hosted domain claim in ID tokens and userinfo for Google OAuth (#73)
- **Stripe Checkout example** — full working example of Stripe Checkout with the Stripe emulator (#82)
- **Resend magic link example** — working example of Resend magic link authentication flow (#51)
- **Docs landing page** — new landing page for the docs site (#81)

### Improvements

- **Unified UI design system** — all emulator UIs now share a consistent design system with CI quality checks (#50)
- **Stripe** — added customer sessions and payment methods API (#47)

### Bug Fixes

- Fixed **AWS S3** emulator compatibility with the official AWS SDK wire format (#65, #69)
- Fixed **Resend** email inbox links not being clickable in preview (#80)

### Contributors

- @ctate
- @disintegrator
- @jlucaso1
- @Railly
- @tmm

## 0.4.1

### Bug Fixes

- Include README in all `@emulators/*` npm packages

## 0.4.0

### New Features

- **Next.js adapter** — embed emulators directly in your Next.js app via `@emulators/adapter-next`, solving the Vercel preview deployment problem where OAuth callback URLs change with every deployment (#43)
- **MongoDB Atlas emulator** — local emulation of MongoDB Atlas with Data API support (#18)
- **Stripe emulator** — local emulation of Stripe billing and payment APIs (#4)
- **Resend emulator** — local emulation of the Resend email API (#7)
- **Okta emulator** — local emulation of Okta authentication and OIDC flows (#32)

### Improvements

- **Microsoft Entra ID** — added v1 OAuth token endpoint and Microsoft Graph `/users/{id}` route (#30)

### Bug Fixes

- Fixed multiple bugs, security hardening, and quality improvements across all emulators (#37)

### Contributors

- @AmorosoDavid12
- @ctate
- @jk4235
- @mvanhorn
