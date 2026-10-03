import type { Context, RouteContext } from "@emulators/core";
import type { SnsPlatform } from "../entities.js";
import { getAwsStore } from "../store.js";
import {
  awsErrorXml,
  awsXmlResponse,
  escapeXml,
  generateMessageId,
  getAccountId,
  getDefaultRegion,
  parseQueryString,
} from "../helpers.js";

const platforms = new Set<string>(["APNS", "APNS_SANDBOX", "GCM"]);
const actions = new Set([
  "CreatePlatformApplication",
  "GetPlatformApplicationAttributes",
  "SetPlatformApplicationAttributes",
  "DeletePlatformApplication",
  "ListPlatformApplications",
  "CreatePlatformEndpoint",
  "GetEndpointAttributes",
  "SetEndpointAttributes",
  "DeleteEndpoint",
  "ListEndpointsByPlatformApplication",
  "Publish",
]);
const namespace = "https://sns.amazonaws.com/doc/2010-03-31/";

function attributesXml(attributes: Record<string, string>): string {
  return `<Attributes>${Object.entries(attributes)
    .map(([key, value]) => `<entry><key>${escapeXml(key)}</key><value>${escapeXml(value)}</value></entry>`)
    .join("")}</Attributes>`;
}

function readAttributes(params: Record<string, string>): Record<string, string> {
  const attributes: Record<string, string> = Object.create(null);
  for (const key of Object.keys(params)) {
    if (!/^Attributes\.entry\.\d+\.key$/.test(key)) continue;
    const valueKey = key.replace(/\.key$/, ".value");
    if (!(valueKey in params) || !params[key]) throw new Error("Attributes require a nonempty key and a value.");
    attributes[params[key]] = params[valueKey];
  }
  return attributes;
}

function validateEndpointAttributes(attributes: Record<string, string>): void {
  for (const key of Object.keys(attributes)) {
    if (!["Enabled", "Token", "CustomUserData"].includes(key))
      throw new Error(`Unsupported endpoint attribute: ${key}`);
  }
  if (attributes.Enabled !== undefined && !["true", "false"].includes(attributes.Enabled))
    throw new Error("Enabled must be true or false.");
  if (attributes.Token !== undefined && !attributes.Token.trim()) throw new Error("Token must not be empty.");
  if (Buffer.byteLength(attributes.CustomUserData ?? "") >= 2048)
    throw new Error("CustomUserData must be less than 2048 bytes.");
}

// Cursor is scoped to the operation and uses insertion IDs so deletion does not shift subsequent pages.
function page<T extends { id: number }>(items: T[], token: string | undefined, scope: string) {
  let after = 0;
  if (token !== undefined) {
    const decoded = JSON.parse(Buffer.from(token, "base64url").toString());
    if (decoded.scope !== scope || !Number.isSafeInteger(decoded.after) || decoded.after < 1)
      throw new Error("Invalid NextToken.");
    after = decoded.after;
  }
  const remaining = items.filter((item) => item.id > after).sort((a, b) => a.id - b.id);
  const selected = remaining.slice(0, 100);
  const next =
    remaining.length > 100
      ? Buffer.from(JSON.stringify({ scope, after: selected[99].id })).toString("base64url")
      : undefined;
  return { selected, next };
}

export function snsRoutes({ app, store }: RouteContext): void {
  const aws = () => getAwsStore(store);

  // Inspection is local-only state: acceptance never means delivery to a provider or device.
  app.get("/_emulate/sns/messages", (c) => {
    const target = c.req.query("target_arn");
    const messages = target === undefined ? aws().snsMessages.all() : aws().snsMessages.findBy("target_arn", target);
    return c.json({ messages: messages.sort((a, b) => a.id - b.id) });
  });
  app.get("/_emulate/sns/messages/:messageId", (c) => {
    const message = aws().snsMessages.findOneBy("message_id", c.req.param("messageId"));
    return message ? c.json(message) : c.json({ error: "Message not found" }, 404);
  });

  async function handle(c: Context, params: Record<string, string>) {
    const action = params.Action ?? "";
    const requestId = generateMessageId();
    c.header("x-amzn-RequestId", requestId);
    const ok = (result = "") =>
      awsXmlResponse(
        c,
        `<?xml version="1.0" encoding="UTF-8"?><${action}Response xmlns="${namespace}"><${action}Result>${result}</${action}Result><ResponseMetadata><RequestId>${requestId}</RequestId></ResponseMetadata></${action}Response>`,
      );
    const invalid = (message: string) => awsErrorXml(c, "InvalidParameter", message);
    const missing = () => awsErrorXml(c, "NotFound", "Resource does not exist.", 404);
    if (!actions.has(action)) return awsErrorXml(c, "InvalidAction", "Unsupported SNS action.");
    if (params.Version && params.Version !== "2010-03-31") return invalid("Unsupported SNS API version.");
    // Signing scope selects the region; credentials and signatures are not verified by this emulator.
    const region =
      c.req.header("authorization")?.match(/Credential=[^/]+\/[^/]+\/([^/]+)\/sns\/aws4_request/)?.[1] ??
      getDefaultRegion();
    const prefix = `arn:aws:sns:${region}:${getAccountId()}:`;
    const validArn = (arn: string | undefined, kind: "app" | "endpoint") =>
      !!arn &&
      arn.startsWith(`${prefix}${kind}/`) &&
      new RegExp(
        `^${kind}/(APNS|APNS_SANDBOX|GCM)/[A-Za-z0-9_.-]{1,256}${kind === "endpoint" ? "/[A-Za-z0-9-]+" : ""}$`,
      ).test(arn.slice(prefix.length));

    let attrs: Record<string, string>;
    try {
      attrs = readAttributes(params);
    } catch (error) {
      return invalid((error as Error).message);
    }

    if (action === "CreatePlatformApplication") {
      const { Name: name, Platform: platform } = params;
      if (!name || !/^[A-Za-z0-9_.-]{1,256}$/.test(name) || !platforms.has(platform))
        return invalid("A valid Name and supported Platform are required.");
      if (!attrs.PlatformCredential || (platform !== "GCM" && !attrs.PlatformPrincipal))
        return invalid("Platform credentials are required; use dummy values locally.");
      const arn = `${prefix}app/${platform}/${name}`;
      const existing = aws().snsPlatformApplications.findOneBy("arn", arn);
      if (existing) {
        if (
          Object.keys(attrs).length !== Object.keys(existing.attributes).length ||
          Object.entries(attrs).some(([k, v]) => existing.attributes[k] !== v)
        )
          return invalid("Platform application already exists with different attributes.");
      } else {
        aws().snsPlatformApplications.insert({ arn, name, platform: platform as SnsPlatform, attributes: attrs });
      }
      return ok(`<PlatformApplicationArn>${escapeXml(arn)}</PlatformApplicationArn>`);
    }

    if (action === "ListPlatformApplications") {
      try {
        const { selected, next } = page(
          aws()
            .snsPlatformApplications.all()
            .filter((a) => a.arn.startsWith(prefix)),
          params.NextToken,
          prefix,
        );
        return ok(
          `<PlatformApplications>${selected.map((a) => `<member><PlatformApplicationArn>${escapeXml(a.arn)}</PlatformApplicationArn>${attributesXml(a.attributes)}</member>`).join("")}</PlatformApplications>${next ? `<NextToken>${next}</NextToken>` : ""}`,
        );
      } catch {
        return invalid("Invalid NextToken.");
      }
    }

    if (
      [
        "GetPlatformApplicationAttributes",
        "SetPlatformApplicationAttributes",
        "DeletePlatformApplication",
        "CreatePlatformEndpoint",
        "ListEndpointsByPlatformApplication",
      ].includes(action)
    ) {
      if (!validArn(params.PlatformApplicationArn, "app"))
        return invalid("Invalid PlatformApplicationArn for this region.");
      const application = aws().snsPlatformApplications.findOneBy("arn", params.PlatformApplicationArn);
      if (!application) return action === "DeletePlatformApplication" ? ok() : missing();
      if (action === "GetPlatformApplicationAttributes") return ok(attributesXml(application.attributes));
      if (action === "SetPlatformApplicationAttributes") {
        if (!Object.keys(attrs).length) return invalid("Attributes are required.");
        aws().snsPlatformApplications.update(application.id, { attributes: { ...application.attributes, ...attrs } });
        return ok();
      }
      if (action === "DeletePlatformApplication") {
        for (const endpoint of aws().snsEndpoints.findBy("platform_application_arn", application.arn))
          aws().snsEndpoints.delete(endpoint.id);
        aws().snsPlatformApplications.delete(application.id);
        return ok();
      }
      if (action === "ListEndpointsByPlatformApplication") {
        try {
          const { selected, next } = page(
            aws().snsEndpoints.findBy("platform_application_arn", application.arn),
            params.NextToken,
            application.arn,
          );
          return ok(
            `<Endpoints>${selected.map((e) => `<member><EndpointArn>${escapeXml(e.arn)}</EndpointArn>${attributesXml(e.attributes)}</member>`).join("")}</Endpoints>${next ? `<NextToken>${next}</NextToken>` : ""}`,
          );
        } catch {
          return invalid("Invalid NextToken.");
        }
      }
      if (!params.Token?.trim()) return invalid("Token is required.");
      if (attrs.Token !== undefined && attrs.Token !== params.Token) return invalid("Conflicting Token attributes.");
      const attributes = {
        Enabled: "true",
        ...attrs,
        Token: params.Token,
        ...(params.CustomUserData !== undefined ? { CustomUserData: params.CustomUserData } : {}),
      };
      try {
        validateEndpointAttributes(attributes);
      } catch (error) {
        return invalid((error as Error).message);
      }
      const existing = aws()
        .snsEndpoints.findBy("platform_application_arn", application.arn)
        .find((e) => e.attributes.Token === attributes.Token);
      if (existing) {
        if (Object.entries(attributes).some(([k, v]) => (existing.attributes[k] ?? "") !== v))
          return invalid("Endpoint already exists with the same Token and different attributes.");
        return ok(`<EndpointArn>${escapeXml(existing.arn)}</EndpointArn>`);
      }
      const arn = `${prefix}endpoint/${application.platform}/${application.name}/${generateMessageId()}`;
      aws().snsEndpoints.insert({ arn, platform_application_arn: application.arn, attributes });
      return ok(`<EndpointArn>${escapeXml(arn)}</EndpointArn>`);
    }

    const endpointArn = action === "Publish" ? params.TargetArn : params.EndpointArn;
    if (!validArn(endpointArn, "endpoint")) return invalid("A platform endpoint ARN in this region is required.");
    const endpoint = aws().snsEndpoints.findOneBy("arn", endpointArn!);
    if (!endpoint) return action === "DeleteEndpoint" ? ok() : missing();
    if (action === "GetEndpointAttributes") return ok(attributesXml(endpoint.attributes));
    if (action === "DeleteEndpoint") {
      aws().snsEndpoints.delete(endpoint.id);
      return ok();
    }
    if (action === "SetEndpointAttributes") {
      if (!Object.keys(attrs).length) return invalid("Attributes are required.");
      try {
        validateEndpointAttributes(attrs);
      } catch (error) {
        return invalid((error as Error).message);
      }
      const attributes = { ...endpoint.attributes, ...attrs };
      if (
        aws()
          .snsEndpoints.findBy("platform_application_arn", endpoint.platform_application_arn)
          .some((e) => e.id !== endpoint.id && e.attributes.Token === attributes.Token)
      )
        return invalid("Token is already registered to another endpoint.");
      aws().snsEndpoints.update(endpoint.id, { attributes });
      return ok();
    }

    if (params.TopicArn || params.PhoneNumber) return invalid("Only Publish to a platform TargetArn is supported.");
    if (params.Subject !== undefined || Object.keys(params).some((k) => k.startsWith("MessageAttributes.")))
      return invalid("Subject and MessageAttributes are not supported by mobile push emulation.");
    if (!params.Message || Buffer.byteLength(params.Message) > 262144)
      return invalid("Message must contain between 1 and 262144 bytes.");
    if (params.MessageStructure && params.MessageStructure !== "json")
      return invalid("MessageStructure must be json or omitted.");
    const application = aws().snsPlatformApplications.findOneBy("arn", endpoint.platform_application_arn)!;
    let payload = params.Message;
    if (params.MessageStructure === "json") {
      try {
        const envelope = JSON.parse(params.Message);
        if (
          !envelope ||
          Array.isArray(envelope) ||
          typeof envelope !== "object" ||
          typeof envelope.default !== "string"
        )
          throw new Error();
        for (const platform of platforms) {
          if (envelope[platform] === undefined) continue;
          if (typeof envelope[platform] !== "string") throw new Error();
          const parsed = JSON.parse(envelope[platform]);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        }
        payload = envelope[application.platform] ?? envelope.default;
      } catch {
        return invalid(
          "Message must be a JSON object with a string default and JSON object strings for mobile protocols.",
        );
      }
    }
    if (endpoint.attributes.Enabled !== "true") return awsErrorXml(c, "EndpointDisabled", "Endpoint is disabled.");
    const messageId = generateMessageId();
    aws().snsMessages.insert({
      message_id: messageId,
      target_arn: endpoint.arn,
      platform_application_arn: application.arn,
      platform: application.platform,
      token: endpoint.attributes.Token,
      message: params.Message,
      message_structure: params.MessageStructure ?? "",
      payload,
      status: "captured",
    });
    return ok(`<MessageId>${messageId}</MessageId>`);
  }

  for (const path of ["/sns", "/sns/"]) {
    app.post(path, async (c) =>
      handle(c, { ...Object.fromEntries(new URL(c.req.url).searchParams), ...parseQueryString(await c.req.text()) }),
    );
    app.get(path, (c) => handle(c, Object.fromEntries(new URL(c.req.url).searchParams)));
  }
  // Inspect a clone only for query requests, preserving the original S3 body.
  app.use("/", async (c, next) => {
    const signedSns = /\/sns\/aws4_request/.test(c.req.header("authorization") ?? "");
    let params = Object.fromEntries(new URL(c.req.url).searchParams);
    if (c.req.method === "POST") {
      if (!signedSns && !c.req.header("content-type")?.includes("application/x-www-form-urlencoded")) return next();
      params = { ...params, ...parseQueryString(await c.req.raw.clone().text()) };
    } else if (c.req.method !== "GET") return next();
    if (actions.has(params.Action) || signedSns) return handle(c, params);
    return next();
  });
}
