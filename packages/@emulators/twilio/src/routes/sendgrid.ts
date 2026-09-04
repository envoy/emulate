import { randomUUID } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { Entity, RouteContext } from "@emulators/core";
import { constantTimeEqual } from "../helpers.js";

export interface SendGridEmail extends Entity {
  message_id: string;
  request: Record<string, unknown>;
}

export interface SendGridOptions {
  apiKeys?: string[];
  gmail?: { baseUrl: string; accessToken: string; userId?: string };
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

export function sendgridRoutes({ app, store }: RouteContext, options: SendGridOptions = {}): void {
  app.post("/v3/mail/send", async (c) => {
    const authorization = c.req.header("Authorization") ?? "";
    const token = /^Bearer (\S+)$/i.exec(authorization)?.[1];
    const keys = options.apiKeys ?? store.getData<string[]>("twilio.sendgrid.apiKeys") ?? ["SG.emulate-test-key"];
    if (!token || !keys.some((key) => constantTimeEqual(token, key))) {
      return c.json(
        {
          errors: [{ message: "Permission denied, wrong credentials", field: null, help: null }],
        },
        401,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const invalid = (field: string, message: string) => c.json({ errors: [{ message, field, help: null }] }, 400);
    if (!record(body)) return invalid("body", "A JSON object is required.");
    const unsupported = (field: string) =>
      c.json({ errors: [{ message: "This feature is not emulated.", field, help: null }] }, 501);
    for (const field of ["template_id", "send_at"]) {
      if (body[field] !== undefined) return unsupported(field);
    }
    if (!address(body.from)) return invalid("from", "A valid sender email is required.");
    if (body.reply_to !== undefined && !address(body.reply_to))
      return invalid("reply_to", "A valid reply-to email is required.");
    if (
      body.headers !== undefined &&
      (!record(body.headers) ||
        !Object.entries(body.headers).every(
          ([key, value]) => /^[A-Za-z0-9-]+$/.test(key) && typeof value === "string" && !/[\r\n]/.test(value),
        ))
    ) {
      return invalid("headers", "String header values without line breaks are required.");
    }
    if (body.mail_settings !== undefined) {
      if (!record(body.mail_settings)) return invalid("mail_settings", "An object is required.");
      const sandbox = body.mail_settings.sandbox_mode;
      if (sandbox !== undefined && (!record(sandbox) || typeof sandbox.enable !== "boolean")) {
        return invalid("mail_settings.sandbox_mode.enable", "A boolean is required.");
      }
    }
    if (!Array.isArray(body.personalizations) || body.personalizations.length === 0) {
      return invalid("personalizations", "At least one personalization is required.");
    }
    for (const [index, personalization] of body.personalizations.entries()) {
      if (
        !record(personalization) ||
        !Array.isArray(personalization.to) ||
        personalization.to.length === 0 ||
        !personalization.to.every(address)
      ) {
        return invalid(`personalizations.${index}.to`, "Valid recipient emails are required.");
      }
      for (const field of ["cc", "bcc"] as const) {
        const recipients = personalization[field];
        if (recipients !== undefined && (!Array.isArray(recipients) || !recipients.every(address))) {
          return invalid(`personalizations.${index}.${field}`, "Valid recipient emails are required.");
        }
      }
      if (personalization.send_at !== undefined) return unsupported(`personalizations.${index}.send_at`);
      const subject = personalization.subject ?? body.subject;
      if (typeof subject !== "string" || subject.length === 0) {
        return invalid("subject", "A nonempty subject is required.");
      }
    }
    if (
      !Array.isArray(body.content) ||
      body.content.length === 0 ||
      !body.content.every(
        (part) =>
          record(part) && typeof part.type === "string" && typeof part.value === "string" && part.value.length > 0,
      )
    ) {
      return invalid("content", "Nonempty MIME content is required.");
    }
    if (body.attachments !== undefined) {
      if (!Array.isArray(body.attachments)) return invalid("attachments", "An array is required.");
      for (const [index, attachment] of body.attachments.entries()) {
        if (
          !record(attachment) ||
          typeof attachment.content !== "string" ||
          attachment.content.length === 0 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attachment.content)
        ) {
          return invalid(`attachments.${index}.content`, "Base64 attachment content is required.");
        }
        if (typeof attachment.filename !== "string" || attachment.filename.length === 0) {
          return invalid(`attachments.${index}.filename`, "A filename is required.");
        }
      }
    }
    if (
      record(body.mail_settings) &&
      record(body.mail_settings.sandbox_mode) &&
      body.mail_settings.sandbox_mode.enable === true
    ) {
      return new Response(null, { status: 200 });
    }
    const messageId = randomUUID();
    const gmail = options.gmail ?? store.getData<SendGridOptions["gmail"]>("twilio.sendgrid.gmail");
    if (gmail) {
      try {
        const url = new URL(
          `/gmail/v1/users/${encodeURIComponent(gmail.userId ?? "me")}/messages/import`,
          gmail.baseUrl,
        );
        for (const personalization of body.personalizations as Record<string, unknown>[]) {
          const contents = body.content as Array<{ type: string; value: string }>;
          const composed = new MailComposer({
            from: mailAddress(body.from),
            to: (personalization.to as unknown[]).map(mailAddress),
            cc: (personalization.cc as unknown[] | undefined)?.map(mailAddress),
            bcc: (personalization.bcc as unknown[] | undefined)?.map(mailAddress),
            headers: body.headers as Record<string, string> | undefined,
            replyTo: body.reply_to ? mailAddress(body.reply_to) : undefined,
            subject: String(personalization.subject ?? body.subject),
            html: contents.find((part) => part.type === "text/html")?.value,
            text: contents.find((part) => part.type === "text/plain")?.value,
            messageId: `<${messageId}@sendgrid.emulate.local>`,
            attachments: (
              body.attachments as Array<{ filename: string; type?: string; content: string }> | undefined
            )?.map((attachment) => ({
              filename: attachment.filename,
              contentType: attachment.type,
              content: Buffer.from(attachment.content, "base64"),
            })),
            disableFileAccess: true,
            disableUrlAccess: true,
          }).compile();
          // The configured Gmail mailbox is a test capture inbox, not a recipient delivery service.
          composed.keepBcc = true;
          const raw = await composed.build();
          const response = await (options.fetch ?? globalThis.fetch)(url.href, {
            method: "POST",
            headers: { Authorization: `Bearer ${gmail.accessToken}`, "Content-Type": "application/json" },
            signal: AbortSignal.timeout(10_000),
            body: JSON.stringify({
              raw: raw.toString("base64url"),
              labelIds: ["INBOX", "UNREAD"],
            }),
          });
          if (!response.ok) {
            throw new Error("Gmail rejected the import");
          }
        }
      } catch {
        return c.json({ errors: [{ message: "Emulated Gmail delivery failed.", field: null, help: null }] }, 502);
      }
    }
    store.collection<SendGridEmail>("twilio.sendgrid.emails").insert({
      message_id: messageId,
      request: body,
    });
    return new Response(null, { status: 202, headers: { "x-message-id": messageId } });
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function address(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) &&
    (value.name === undefined || typeof value.name === "string")
  );
}

function mailAddress(value: unknown): { name: string; address: string } {
  const address = value as { email: string; name?: string };
  return { name: address.name ?? "", address: address.email };
}
