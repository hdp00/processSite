import { Injectable } from "@nestjs/common";
import nodemailer from "nodemailer";
import type SMTPPool from "nodemailer/lib/smtp-pool/index.js";
import {
  type SmtpMailConfiguration,
  type SmtpTransport,
  type SmtpTransportFactory,
  type SmtpTransportMessage,
  type SmtpTransportSendResult,
} from "./mail.types.js";

const smtpPoolOptions = (configuration: SmtpMailConfiguration): SMTPPool.Options => ({
  pool: true,
  host: configuration.host,
  port: configuration.port,
  secure: configuration.secure,
  requireTLS: configuration.requireTls,
  ignoreTLS: configuration.ignoreTls,
  connectionTimeout: configuration.connectionTimeoutMs,
  greetingTimeout: configuration.greetingTimeoutMs,
  socketTimeout: configuration.socketTimeoutMs,
  maxConnections: configuration.maxConnections,
  tls: {
    rejectUnauthorized: configuration.tlsRejectUnauthorized,
    ...(configuration.tlsServername ? { servername: configuration.tlsServername } : {}),
  },
  ...(configuration.username && configuration.password
    ? { auth: { user: configuration.username, pass: configuration.password } }
    : {}),
});

class NodemailerSmtpTransport implements SmtpTransport {
  constructor(
    private readonly transport: ReturnType<typeof nodemailer.createTransport<SMTPPool.SentMessageInfo>>
  ) {}

  async sendMail(message: SmtpTransportMessage): Promise<SmtpTransportSendResult> {
    const result = await this.transport.sendMail(message);
    return {
      messageId: result.messageId || null,
      acceptedCount: result.accepted.length,
      rejectedCount: result.rejected.length,
    };
  }

  async verify(): Promise<boolean> {
    return (await this.transport.verify()) === true;
  }

  close(): void {
    this.transport.close();
  }
}

@Injectable()
export class NodemailerSmtpTransportFactory implements SmtpTransportFactory {
  create(configuration: SmtpMailConfiguration): SmtpTransport {
    const transport = nodemailer.createTransport<SMTPPool.SentMessageInfo>(smtpPoolOptions(configuration));
    return new NodemailerSmtpTransport(transport);
  }
}
