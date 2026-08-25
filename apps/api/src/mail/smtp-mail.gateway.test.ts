import { Logger } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SmtpMailConfiguration,
  SmtpMailError,
  type SmtpTransport,
  type SmtpTransportFactory,
  type SmtpTransportMessage,
} from "./mail.types.js";
import { SmtpMailGateway } from "./smtp-mail.gateway.js";

const configuration = (overrides: Partial<SmtpMailConfiguration> = {}): SmtpMailConfiguration => ({
  enabled: true,
  host: "smtp.internal.example",
  port: 25,
  secure: false,
  requireTls: true,
  ignoreTls: false,
  tlsRejectUnauthorized: true,
  tlsServername: "smtp.internal.example",
  username: "flowpilot@example.invalid",
  password: "smtp-unit-test-secret",
  from: "flowpilot@example.invalid",
  replyTo: "no-reply@example.invalid",
  connectionTimeoutMs: 5_000,
  greetingTimeoutMs: 5_000,
  socketTimeoutMs: 15_000,
  maxConnections: 5,
  ...overrides,
});

class FakeTransport implements SmtpTransport {
  readonly sendMail = vi.fn(async (_message: SmtpTransportMessage) => ({
    messageId: "message-1",
    acceptedCount: 2,
    rejectedCount: 0,
  }));

  readonly verify = vi.fn(async () => true);
  readonly close = vi.fn(() => undefined);
}

class FakeTransportFactory implements SmtpTransportFactory {
  readonly create: ReturnType<typeof vi.fn<(configuration: SmtpMailConfiguration) => SmtpTransport>>;

  constructor(transport: SmtpTransport) {
    this.create = vi.fn((_configuration: SmtpMailConfiguration) => transport);
  }
}

describe("SmtpMailGateway", () => {
  let transport: FakeTransport;
  let factory: FakeTransportFactory;

  beforeEach(() => {
    transport = new FakeTransport();
    factory = new FakeTransportFactory(transport);
  });

  it("maps text mail, fixed sender, reply-to and Bcc without accepting an arbitrary From", async () => {
    const gateway = new SmtpMailGateway(configuration(), factory);

    await expect(gateway.send({
      to: ["owner@example.invalid", "reviewer@example.invalid"],
      bcc: ["audit@example.invalid"],
      subject: "审批提醒",
      content: { format: "text", body: "请处理待办。" },
    })).resolves.toEqual({ messageId: "message-1", acceptedCount: 2, rejectedCount: 0 });

    expect(transport.sendMail).toHaveBeenCalledWith({
      from: "flowpilot@example.invalid",
      replyTo: "no-reply@example.invalid",
      to: ["owner@example.invalid", "reviewer@example.invalid"],
      bcc: ["audit@example.invalid"],
      subject: "审批提醒",
      text: "请处理待办。",
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    expect(transport.sendMail.mock.calls[0]?.[0]).not.toHaveProperty("html");
  });

  it("maps HTML content without rewriting or duplicating it as plain text", async () => {
    const gateway = new SmtpMailGateway(configuration({ replyTo: undefined }), factory);
    const html = "<p>第一行</p><p>第二行</p>";

    await gateway.send({
      to: ["owner@example.invalid"],
      subject: "流程完成",
      content: { format: "html", body: html },
    });

    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({ html }));
    expect(transport.sendMail.mock.calls[0]?.[0]).not.toHaveProperty("text");
    expect(transport.sendMail.mock.calls[0]?.[0]).not.toHaveProperty("replyTo");
    expect(transport.sendMail.mock.calls[0]?.[0]).not.toHaveProperty("bcc");
  });

  it("verifies lazily, caches the pool and closes it on shutdown", async () => {
    const gateway = new SmtpMailGateway(configuration(), factory);

    await expect(gateway.verify()).resolves.toEqual({ available: true, code: "SMTP_OK" });
    await gateway.send({
      to: ["owner@example.invalid"],
      subject: "提醒",
      content: { format: "text", body: "正文" },
    });
    expect(factory.create).toHaveBeenCalledTimes(1);

    gateway.onApplicationShutdown();
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("reports disabled and unavailable health with stable codes", async () => {
    const disabled = new SmtpMailGateway(configuration({ enabled: false }), factory);
    await expect(disabled.verify()).resolves.toEqual({ available: false, code: "SMTP_DISABLED" });
    expect(factory.create).not.toHaveBeenCalled();
    await expect(disabled.send({
      to: ["owner@example.invalid"],
      subject: "提醒",
      content: { format: "text", body: "正文" },
    })).rejects.toMatchObject({ code: "SMTP_DISABLED" });

    transport.verify.mockRejectedValueOnce(new Error("internal SMTP host detail"));
    const unavailable = new SmtpMailGateway(configuration(), factory);
    await expect(unavailable.verify()).resolves.toEqual({ available: false, code: "SMTP_UNAVAILABLE" });
  });

  it("normalizes provider send failures without logging credentials or provider details", async () => {
    const loggerSpies = [
      vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined),
      vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined),
      vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined),
      vi.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined),
      vi.spyOn(Logger.prototype, "verbose").mockImplementation(() => undefined),
    ];
    transport.sendMail.mockRejectedValueOnce(new Error("535 smtp-unit-test-secret rejected"));
    const gateway = new SmtpMailGateway(configuration(), factory);

    let failure: unknown;
    try {
      await gateway.send({
        to: ["owner@example.invalid"],
        subject: "提醒",
        content: { format: "text", body: "正文" },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SmtpMailError);
    expect(failure).toMatchObject({ code: "SMTP_SEND_FAILED", message: "邮件发送失败，请稍后重试。" });
    expect(String(failure)).not.toContain("smtp-unit-test-secret");
    for (const loggerSpy of loggerSpies) expect(loggerSpy).not.toHaveBeenCalled();
  });

  it.each([
    { message: { to: [], subject: "提醒", content: { format: "text" as const, body: "正文" } }, reason: "empty recipient" },
    { message: { to: ["owner@example.invalid\r\nBcc: injected@example.invalid"], subject: "提醒", content: { format: "text" as const, body: "正文" } }, reason: "recipient header injection" },
    { message: { to: ["Owner <owner@example.invalid>"], subject: "提醒", content: { format: "text" as const, body: "正文" } }, reason: "display-name recipient" },
    { message: { to: [" owner@example.invalid "], subject: "提醒", content: { format: "text" as const, body: "正文" } }, reason: "non-canonical whitespace" },
    { message: { to: ["owner@-example.invalid"], subject: "提醒", content: { format: "text" as const, body: "正文" } }, reason: "invalid domain label" },
    { message: { to: ["owner@example.invalid"], subject: "提醒\r\nX-Header: injected", content: { format: "text" as const, body: "正文" } }, reason: "subject header injection" },
  ])("rejects an invalid message before SMTP access: $reason", async ({ message }) => {
    const gateway = new SmtpMailGateway(configuration(), factory);

    await expect(gateway.send(message)).rejects.toMatchObject({ code: "SMTP_MESSAGE_INVALID" });
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it.each([
    { username: "user", password: undefined },
    { username: undefined, password: "secret" },
    { maxConnections: 6 },
    { requireTls: true, ignoreTls: true },
    { secure: true, requireTls: false, ignoreTls: true },
    { secure: false, requireTls: false, ignoreTls: false },
    { from: "FlowPilot\r\nBcc: injected@example.invalid" },
  ])("fails fast for an invalid SMTP configuration", (override) => {
    expect(() => new SmtpMailGateway(configuration(override), factory)).toThrowError(
      expect.objectContaining({ code: "SMTP_CONFIGURATION_INVALID", message: "SMTP 邮件配置无效。" })
    );
    expect(factory.create).not.toHaveBeenCalled();
  });
});
