---
name: cloudflare
description: Test an application's explicit Cloudflare Turnstile widget and Siteverify integration.
---

# Cloudflare Turnstile

Start with `npx @envoy/emulate init --service cloudflare`, then configure `cloudflare.sites` with a `sitekey`, `secret`, and explicit `hostnames` array. Start with `npx @envoy/emulate start --service cloudflare --seed emulate.config.yaml`.

In the test application, load the emulator's `/turnstile/v0/api.js?render=explicit` and use the configured sitekey. The `turnstile.render` callback supplies a token; submit it to your backend. Point that backend's Siteverify request at `/turnstile/v0/siteverify` and send the configured secret and response token using JSON or form encoding.

Assert one successful verification and failure for a reused token. Tokens expire after five minutes and are bound to the seeded site. `ready`, `render`, `getResponse`, `isExpired`, `reset`, and `remove` are supported. The widget completes automatically and has success, error, and expiry callbacks. Sites and tokens use Core Store snapshots/reset and its persistence adapters.

Keep production URLs unchanged. The emulator does not perform bot detection, real challenges, implicit rendering, `execute`, idempotency retries, account administration, or Enterprise metadata. `/turnstile/v0/issue` and `/turnstile/v0/widget` are emulator-only helpers, and hostname checks rely on the declared parent origin.
