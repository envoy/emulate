import { randomUUID } from "node:crypto";
import type {
  AppEnv,
  Collection,
  Context,
  Entity,
  Hono,
  ServicePlugin,
  Store,
  TokenMap,
  ContentfulStatusCode,
} from "@emulators/core";
import { consumeCardToken } from "@emulators/stripe";

export interface ChargebeeObject extends Entity {
  resource_id: string;
  data: Record<string, unknown>;
}
export interface ChargebeeSeedConfig {
  plans?: Array<Record<string, unknown> & { id: string; name: string }>;
  customers?: Array<Record<string, unknown> & { id: string }>;
}
export function getChargebeeStore(store: Store) {
  return {
    plans: store.collection<ChargebeeObject>("chargebee.plans", ["resource_id"]),
    customers: store.collection<ChargebeeObject>("chargebee.customers", ["resource_id"]),
    subscriptions: store.collection<ChargebeeObject>("chargebee.subscriptions", ["resource_id"]),
    paymentSources: store.collection<ChargebeeObject>("chargebee.payment_sources", ["resource_id"]),
  };
}
const now = () => Math.floor(Date.now() / 1000);
const validId = (value: unknown): value is string => typeof value === "string" && /^[\w.-]{1,100}$/.test(value);
function error(c: Context, status: number, code: string, message: string, param?: string) {
  return c.json(
    {
      type: status === 401 ? "authentication_error" : "invalid_request",
      api_error_code: code,
      message,
      http_status_code: status,
      ...(param ? { param } : {}),
    },
    status as ContentfulStatusCode,
  );
}
function resource(row: ChargebeeObject) {
  return structuredClone(row.data);
}
function insert(collection: Collection<ChargebeeObject>, object: string, data: Record<string, unknown>, id: string) {
  return collection.insert({
    resource_id: id,
    data: {
      ...structuredClone(data),
      id,
      object,
      created_at: now(),
      updated_at: now(),
      resource_version: Date.now(),
      deleted: false,
    },
  });
}
function update(collection: Collection<ChargebeeObject>, row: ChargebeeObject, data: Record<string, unknown>) {
  return collection.update(row.id, {
    data: {
      ...row.data,
      ...structuredClone(data),
      id: row.resource_id,
      object: row.data.object,
      updated_at: now(),
      resource_version: Math.max(Date.now(), Number(row.data.resource_version) + 1),
    },
  })!;
}
async function body(c: Context): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(await c.req.text())) {
    if (key === "meta_data") {
      try {
        data[key] = JSON.parse(value);
      } catch {
        throw new Error("meta_data must be JSON");
      }
    } else {
      const nested = /^(billing_address|card)\[(\w+)\]$/.exec(key);
      if (nested) {
        const group = (data[nested[1]] ??= {});
        (group as Record<string, unknown>)[nested[2]] = value;
      } else data[key] = value;
    }
  }
  return data;
}
function selected(data: Record<string, unknown>, fields: string[]) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => fields.includes(key) || /^cf_\w+$/.test(key)));
}
const customerDefaults = {
  auto_collection: "on",
  promotional_credits: 0,
  excess_payments: 0,
  refundable_credits: 0,
  unbilled_charges: 0,
  net_term_days: 0,
};
const customerFields = [
  "company",
  "first_name",
  "last_name",
  "email",
  "phone",
  "auto_collection",
  "net_term_days",
  "billing_address",
  "meta_data",
  "locale",
  "taxability",
];
function planData(input: Record<string, unknown>) {
  const period = Number(input.period ?? 1),
    price = Number(input.price ?? 0),
    trial = Number(input.trial_period ?? 0);
  if (
    !Number.isInteger(period) ||
    period < 1 ||
    !Number.isInteger(price) ||
    price < 0 ||
    !Number.isInteger(trial) ||
    trial < 0
  )
    throw new Error("Invalid plan price or period");
  const unit = input.period_unit ?? "month",
    trialUnit = input.trial_period_unit ?? "day";
  if (
    !["day", "week", "month", "year"].includes(String(unit)) ||
    !["day", "week", "month", "year"].includes(String(trialUnit))
  )
    throw new Error("Invalid period unit");
  if (!["flat_fee", "per_unit"].includes(String(input.pricing_model ?? "per_unit")))
    throw new Error("Only flat_fee and per_unit pricing are supported");
  return {
    status: "active",
    currency_code: "USD",
    ...selected(input, ["name", "invoice_name", "status", "currency_code", "pricing_model", "meta_data"]),
    pricing_model: input.pricing_model ?? "per_unit",
    period,
    period_unit: unit,
    price,
    trial_period: trial,
    trial_period_unit: trialUnit,
  };
}
function advance(timestamp: number, amount: number, unit: string) {
  const date = new Date(timestamp * 1000);
  if (unit === "month") date.setUTCMonth(date.getUTCMonth() + amount);
  else if (unit === "year") date.setUTCFullYear(date.getUTCFullYear() + amount);
  else date.setUTCDate(date.getUTCDate() + amount * (unit === "week" ? 7 : 1));
  return Math.floor(date.getTime() / 1000);
}
function list(c: Context, collection: Collection<ChargebeeObject>, key: string) {
  let rows = collection.all();
  for (const [field, value] of new URL(c.req.url).searchParams) {
    if (["limit", "offset"].includes(field)) continue;
    const match = /^(id|customer_id|status|company|plan_id)\[(is|in)\]$/.exec(field);
    if (!match || (match[1] === "plan_id" && key !== "subscription"))
      return error(c, 400, "param_wrong_value", "Unsupported list filter", field);
    let values = [value];
    if (match[2] === "in") {
      try {
        values = JSON.parse(value);
      } catch {
        values = value
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((s) => s.trim());
      }
      if (!Array.isArray(values) || !values.every((v) => typeof v === "string"))
        return error(c, 400, "param_wrong_value", "Invalid list filter", field);
    }
    rows = rows.filter((row) => values.includes(String(row.data[match[1]])));
  }
  const limit = Number(c.req.query("limit") ?? 10),
    offset = Number(c.req.query("offset") ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0)
    return error(c, 400, "param_wrong_value", "Invalid pagination");
  return c.json({
    list: rows.slice(offset, offset + limit).map((row) => ({ [key]: resource(row) })),
    ...(offset + limit < rows.length ? { next_offset: String(offset + limit) } : {}),
  });
}
export function seedFromConfig(store: Store, _baseUrl: string, config: ChargebeeSeedConfig) {
  const db = getChargebeeStore(store);
  for (const plan of config.plans ?? []) {
    if (!validId(plan.id) || !plan.name) throw new Error("Plan id and name are required");
    const data = planData(plan);
    const existing = db.plans.findOneBy("resource_id", plan.id);
    if (existing) update(db.plans, existing, data);
    else insert(db.plans, "plan", data, plan.id);
  }
  for (const customer of config.customers ?? []) {
    if (!validId(customer.id)) throw new Error("Customer id is required");
    const data = { ...customerDefaults, ...selected(customer, customerFields) };
    const existing = db.customers.findOneBy("resource_id", customer.id);
    if (existing) update(db.customers, existing, data);
    else insert(db.customers, "customer", data, customer.id);
  }
}
function register(app: Hono<AppEnv>, store: Store, _webhooks: unknown, _baseUrl: string, tokens?: TokenMap) {
  const db = getChargebeeStore(store);
  app.use("/api/v2/:rest{.*}", async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const encoded = /^Basic ([A-Za-z0-9+/]+=*)$/.exec(header)?.[1];
    const credentials = encoded ? Buffer.from(encoded, "base64").toString() : "";
    const index = credentials.indexOf(":");
    if (index < 1 || !tokens?.has(credentials.slice(0, index)))
      return error(c, 401, "api_authentication_failed", "Invalid API key");
    await next();
  });
  for (const [path, key, collection] of [
    ["plans", "plan", db.plans],
    ["customers", "customer", db.customers],
    ["subscriptions", "subscription", db.subscriptions],
    ["payment_sources", "payment_source", db.paymentSources],
  ] as const) {
    app.get(`/api/v2/${path}`, (c) => list(c, collection, key));
    app.get(`/api/v2/${path}/:id`, (c) => {
      const row = collection.findOneBy("resource_id", c.req.param("id"));
      return row ? c.json({ [key]: resource(row) }) : error(c, 404, "resource_not_found", `${key} not found`);
    });
  }
  // No invoice or ACH is created by the supported trial/card flows.
  for (const path of ["invoices", "virtual_bank_accounts"]) app.get(`/api/v2/${path}`, (c) => c.json({ list: [] }));
  for (const [path, collection, key] of [
    ["customers", db.customers, "customer"],
    ["plans", db.plans, "plan"],
  ] as const) {
    app.post(`/api/v2/${path}`, async (c) => {
      let input;
      try {
        input = await body(c);
      } catch {
        return error(c, 400, "param_wrong_value", "Invalid form data");
      }
      const id = input.id ?? `${key}_${randomUUID()}`;
      if (!validId(id)) return error(c, 400, "param_wrong_value", "Invalid id", "id");
      if (collection.findOneBy("resource_id", id)) return error(c, 400, "duplicate_entry", "ID already exists", "id");
      let data;
      try {
        data = key === "plan" ? planData(input) : { ...customerDefaults, ...selected(input, customerFields) };
      } catch (e) {
        return error(c, 400, "param_wrong_value", (e as Error).message);
      }
      return c.json({ [key]: resource(insert(collection, key, data, id)) });
    });
    app.post(`/api/v2/${path}/:id`, async (c) => {
      const row = collection.findOneBy("resource_id", c.req.param("id"));
      if (!row) return error(c, 404, "resource_not_found", `${key} not found`);
      let input;
      try {
        input = await body(c);
      } catch {
        return error(c, 400, "param_wrong_value", "Invalid form data");
      }
      let data;
      try {
        data = key === "plan" ? planData({ ...row.data, ...input }) : selected(input, customerFields);
      } catch (e) {
        return error(c, 400, "param_wrong_value", (e as Error).message);
      }
      return c.json({ [key]: resource(update(collection, row, data)) });
    });
  }
  app.post("/api/v2/customers/:id/delete", (c) => {
    const customer = db.customers.findOneBy("resource_id", c.req.param("id"));
    if (!customer) return error(c, 404, "resource_not_found", "Customer not found");
    for (const collection of [db.subscriptions, db.paymentSources]) {
      for (const row of collection.all().filter((row) => row.data.customer_id === customer.resource_id))
        collection.delete(row.id);
    }
    db.customers.delete(customer.id);
    return c.json({ customer: { ...resource(customer), deleted: true } });
  });
  app.post("/api/v2/customers/:id/subscriptions", async (c) => {
    const customer = db.customers.findOneBy("resource_id", c.req.param("id"));
    if (!customer) return error(c, 404, "resource_not_found", "Customer not found");
    let input;
    try {
      input = await body(c);
    } catch {
      return error(c, 400, "param_wrong_value", "Invalid form data");
    }
    const plan = db.plans.findOneBy("resource_id", String(input.plan_id));
    if (!plan || plan.data.status !== "active")
      return error(c, 400, "resource_not_found", "Active plan not found", "plan_id");
    const id = input.id ?? `sub_${randomUUID()}`,
      quantity = Number(input.plan_quantity ?? 1);
    if (!validId(id) || !Number.isInteger(quantity) || quantity < 1)
      return error(c, 400, "param_wrong_value", "Invalid subscription id or quantity");
    if (db.subscriptions.findOneBy("resource_id", id))
      return error(c, 400, "duplicate_entry", "Subscription already exists");
    if (plan.data.pricing_model === "flat_fee" && input.plan_quantity !== undefined)
      return error(c, 400, "param_wrong_value", "Flat fee plans do not accept quantity", "plan_quantity");
    const started = now();
    const trialEnd =
      input.trial_end === undefined
        ? advance(started, Number(plan.data.trial_period), String(plan.data.trial_period_unit))
        : Number(input.trial_end);
    if (!Number.isInteger(trialEnd) || trialEnd < 0)
      return error(c, 400, "param_wrong_value", "Invalid trial end", "trial_end");
    const inTrial = trialEnd > started;
    const subscription = insert(
      db.subscriptions,
      "subscription",
      {
        customer_id: customer.resource_id,
        plan_id: plan.resource_id,
        plan_quantity: quantity,
        plan_unit_price: plan.data.price,
        plan_amount: Number(plan.data.price) * quantity,
        currency_code: plan.data.currency_code,
        billing_period: plan.data.period,
        billing_period_unit: plan.data.period_unit,
        status: inTrial ? "in_trial" : "active",
        started_at: started,
        ...(inTrial
          ? { trial_start: started, trial_end: trialEnd }
          : {
              current_term_start: started,
              current_term_end: advance(started, Number(plan.data.period), String(plan.data.period_unit)),
            }),
        meta_data: input.meta_data ?? {},
        due_invoices_count: 0,
      },
      id,
    );
    return c.json({ subscription: resource(subscription), customer: resource(customer) });
  });
  app.post("/api/v2/subscriptions/:id/cancel", async (c) => {
    const row = db.subscriptions.findOneBy("resource_id", c.req.param("id"));
    if (!row) return error(c, 404, "resource_not_found", "Subscription not found");
    const input = await body(c),
      scheduled = input.end_of_term === "true";
    const result = update(db.subscriptions, row, {
      status: scheduled ? (row.data.status === "in_trial" ? "in_trial" : "non_renewing") : "cancelled",
      cancelled_at: scheduled ? (row.data.trial_end ?? row.data.current_term_end) : now(),
    });
    return c.json({ subscription: resource(result) });
  });
  app.post("/api/v2/payment_sources/create_using_temp_token", async (c) => {
    const input = await body(c);
    const customer = db.customers.findOneBy("resource_id", String(input.customer_id));
    if (!customer) return error(c, 404, "resource_not_found", "Customer not found");
    if (input.type !== "card") return error(c, 400, "param_wrong_value", "Only card sources are supported", "type");
    const card = consumeCardToken(store, String(input.tmp_token));
    if (!card)
      return error(c, 400, "invalid_payment_source", "Temporary token is missing or already used", "tmp_token");
    const names = (card.name ?? "").trim().split(/\s+/);
    const source = insert(
      db.paymentSources,
      "payment_source",
      {
        customer_id: customer.resource_id,
        type: "card",
        status: "valid",
        gateway: "stripe",
        reference_id: card.id,
        card: {
          first_name: names[0],
          last_name: names.slice(1).join(" "),
          last4: card.last4,
          brand: card.brand.toLowerCase(),
          expiry_month: card.exp_month,
          expiry_year: card.exp_year,
          billing_zip: card.address_zip,
          funding_type: card.funding,
        },
      },
      `pm_${randomUUID()}`,
    );
    const updated = customer.data.primary_payment_source_id
      ? customer
      : update(db.customers, customer, { primary_payment_source_id: source.resource_id });
    return c.json({ payment_source: resource(source), customer: resource(updated) });
  });
  app.post("/api/v2/customers/:id/assign_payment_role", async (c) => {
    const customer = db.customers.findOneBy("resource_id", c.req.param("id"));
    if (!customer) return error(c, 404, "resource_not_found", "Customer not found");
    const input = await body(c),
      source = db.paymentSources.findOneBy("resource_id", String(input.payment_source_id));
    if (!source || source.data.customer_id !== customer.resource_id)
      return error(c, 400, "invalid_payment_source", "Customer payment source not found");
    if (!["primary", "backup"].includes(String(input.role)))
      return error(c, 400, "param_wrong_value", "Invalid role", "role");
    const updated = update(db.customers, customer, { [`${input.role}_payment_source_id`]: source.resource_id });
    return c.json({ customer: resource(updated), payment_source: resource(source) });
  });
}
export const chargebeePlugin: ServicePlugin = { name: "chargebee", register };
export default chargebeePlugin;
