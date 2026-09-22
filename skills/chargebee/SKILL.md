---
name: chargebee
description: Configure Chargebee Product Catalog 1 trials and simulated card payment sources.
---

# Chargebee

The Chargebee emulator implements Product Catalog 1 REST APIs for plans, customers, trial subscriptions, scheduled cancellation, and card payment sources. It uses HTTP Basic authentication with configured API keys.

```bash
npx emulate init --service chargebee
npx emulate start --service chargebee --seed emulate.config.yaml
```

Subscription lists support `plan_id[is]` and `plan_id[in]` alongside customer and status filters. Filters combine before pagination; `in` accepts a JSON array of strings.

The API prefix is `/api/v2`. Point your SDK's API origin at the emulator. Seed `chargebee.plans` with `id`, `name`, `price` in cents, `period`, `period_unit`, `trial_period`, and `trial_period_unit`. Custom `cf_*` fields and `meta_data` are preserved.

```yaml
chargebee:
  plans:
    - id: pro-monthly
      name: Pro
      price: 2000
      period: 1
      period_unit: month
      trial_period: 14
      trial_period_unit: day
```

For Stripe temporary-token exchange, register `chargebeePlugin` and `stripePlugin` with the same Core `Store` and configured token map. Independent CLI services have separate stores, so cross-provider token exchange requires this embedded setup. Serve Stripe's `/stripe.js` from that runtime instead of loading the real Stripe script. The shim supports `Stripe(key).elements().create('card')`, mounting, change events, and `createToken`.

Use a configured `pk_test_` key with test card `4242424242424242`, a future expiry, and a three-digit CVC. Tokens are single-use; stored records contain card metadata, never the card number or CVC. Chargebee's `POST /api/v2/payment_sources/create_using_temp_token` consumes the token and stores a source that can be listed or assigned as the customer's primary payment method. Core Store snapshots preserve both providers' state.

This subset does not implement Product Catalog 2, invoice generation, tax calculation, 3DS, or real payment processing. Unsupported operations return errors. Invoice and virtual-bank-account lists are empty because the supported flows do not create those resources.
