# Chargebee Product Catalog 1 contract

| Operation | Boundary | State and validation |
| --- | --- | --- |
| Plans | `/api/v2/plans` and `/:id` | Seeded catalog, list pagination and filters; missing plan is an error |
| Customers | `/api/v2/customers` and `/:id` | Create, retrieve, update and delete; duplicate IDs rejected |
| Trial subscriptions | `/api/v2/customers/:id/subscriptions`, `/api/v2/subscriptions` | Customer and plan must exist; persist trial dates, quantities and scheduled cancellation |
| Card entry | Stripe `/stripe.js`, `/elements/card`, `/v1/tokens` | Elements card subset, test keys/cards only, validation and decline errors; no PAN or CVC persisted |
| Payment sources | `/api/v2/payment_sources/create_using_temp_token` | Consume a single-use Stripe token from the same Store; reject missing or reused tokens |
| Read back and roles | `/api/v2/payment_sources`, `/api/v2/customers/:id/assign_payment_role` | Customer isolation and durable primary/backup selection |
| State lifecycle | Core Store snapshot, restore and reset | Provider collections and token consumption survive snapshots and clear on reset |

Chargebee authenticates HTTP Basic API keys against the configured token map. Stripe token creation accepts configured test publishable or secret keys. Register both plugins with the same Store to exchange temporary tokens. No real payment network, 3DS, tax computation, invoicing engine or Product Catalog 2 behavior is claimed.
