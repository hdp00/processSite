import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SmtpMailConfiguration, SmtpTransportMessage } from "./mail.types.js";

const nodemailerMock = vi.hoisted(() => ({
  close: vi.fn(() => undefined),
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: nodemailerMock.createTransport },
}));

import { NodemailerSmtpTransportFactory } from "./nodemailer-smtp-transport.factory.js";

const configuration: SmtpMailConfiguration = {
  enabled: true,
  host: "smtp.internal.example",
  port: 587,
  secure: false,
  requireTls: true,
  ignoreTls: false,
  tlsRejectUnauthorized: true,
  tlsServername: "smtp.internal.example",
  username: "flowpilot@example.invalid",
  password: "smtp-unit-test-secret",
  from: "flowpilot@example.invalid",
  connectionTimeoutMs: 5_000,
  greetingTimeoutMs: 6_000,
  socketTimeoutMs: 15_000,
  maxConnections: 5,
};

const message: SmtpTransportMessage = {
  from: "flowpilot@example.invalid",
  to: ["owner@example.invalid"],
  subject: "提醒",
  text: "正文",
  disableFileAccess: true,
  disableUrlAccess: true,
};

describe("NodemailerSmtpTransportFactory", () => {
  beforeEach(() => {
    nodemailerMock.sendMail.mockResolvedValue({
      messageId: "smtp-message-id",
      accepted: ["owner@example.invalid"],
      rejected: ["rejected@example.invalid"],
    });
    nodemailerMock.verify.mockResolvedValue(true);
    nodemailerMock.createTransport.mockReturnValue({
      sendMail: nodemailerMock.sendMail,
      verify: nodemailerMock.verify,
      close: nodemailerMock.close,
    });
  });

  it("creates a bounded SMTP pool with authentication, TLS and explicit timeouts", () => {
    new NodemailerSmtpTransportFactory().create(configuration);

    expect(nodemailerMock.createTransport).toHaveBeenCalledWith({
      pool: true,
      host: "smtp.internal.example",
      port: 587,
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      connectionTimeout: 5_000,
      greetingTimeout: 6_000,
      socketTimeout: 15_000,
      maxConnections: 5,
      tls: { rejectUnauthorized: true, servername: "smtp.internal.example" },
      auth: { user: "flowpilot@example.invalid", pass: "smtp-unit-test-secret" },
    });
  });

  it("omits SMTP authentication when no credential pair is configured", () => {
    new NodemailerSmtpTransportFactory().create({
      ...configuration,
      username: undefined,
      password: undefined,
    });

    expect(nodemailerMock.createTransport.mock.calls[0]?.[0]).not.toHaveProperty("auth");
  });

  it("passes through an explicit plain-text SMTP opt-in", () => {
    new NodemailerSmtpTransportFactory().create({
      ...configuration,
      requireTls: false,
      ignoreTls: true,
    });

    expect(nodemailerMock.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      requireTLS: false,
      ignoreTLS: true,
    }));
  });

  it("omits the optional TLS server name when certificate SNI override is not configured", () => {
    new NodemailerSmtpTransportFactory().create({
      ...configuration,
      tlsServername: undefined,
    });

    expect(nodemailerMock.createTransport.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      tls: { rejectUnauthorized: true },
    }));
  });

  it("normalizes delivery metadata, verifies and closes the Nodemailer transport", async () => {
    const transport = new NodemailerSmtpTransportFactory().create(configuration);

    await expect(transport.sendMail(message)).resolves.toEqual({
      messageId: "smtp-message-id",
      acceptedCount: 1,
      rejectedCount: 1,
    });
    await expect(transport.verify()).resolves.toBe(true);
    transport.close();

    expect(nodemailerMock.sendMail).toHaveBeenCalledWith(message);
    expect(nodemailerMock.close).toHaveBeenCalledTimes(1);
  });
});
