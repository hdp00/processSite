import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import {
  SMTP_MAIL_CONFIGURATION,
  SMTP_TRANSPORT_FACTORY,
  type MailDeliveryResult,
  type MailMessage,
  type SmtpMailConfiguration,
  SmtpMailError,
  type SmtpTransport,
  type SmtpTransportFactory,
  type SmtpTransportMessage,
  type SmtpVerificationResult,
} from "./mail.types.js";

const MAX_HEADER_LENGTH = 1_000;
const MAX_SUBJECT_LENGTH = 400;
const MAX_RECIPIENTS_PER_FIELD = 100;

const hasHeaderBreak = (value: string): boolean => /[\r\n]/u.test(value);

/**
 * Outbox addresses are stored separately, so display-name syntax is intentionally
 * rejected here instead of delegating ambiguous header parsing to Nodemailer.
 */
const isPlainEmailAddress = (value: string): boolean => {
  if (value !== value.trim() || value.length > 254 || hasHeaderBreak(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/iu.test(local)) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((label) =>
    label.length >= 1
    && label.length <= 63
    && /^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/iu.test(label)
  );
};

const validateConfiguration = (configuration: SmtpMailConfiguration): void => {
  const authIsPaired = Boolean(configuration.username) === Boolean(configuration.password);
  const tlsModeIsValid =
    !(configuration.requireTls && configuration.ignoreTls)
    && !(configuration.secure && configuration.ignoreTls)
    && (!configuration.enabled || configuration.secure || configuration.requireTls || configuration.ignoreTls);
  const valuesAreValid =
    Number.isInteger(configuration.port)
    && configuration.port >= 1
    && configuration.port <= 65_535
    && Number.isInteger(configuration.maxConnections)
    && configuration.maxConnections >= 1
    && configuration.maxConnections <= 5
    && configuration.connectionTimeoutMs > 0
    && configuration.greetingTimeoutMs > 0
    && configuration.socketTimeoutMs > 0;
  const enabledValuesAreValid = !configuration.enabled || Boolean(
    configuration.host?.trim()
    && configuration.from
    && isPlainEmailAddress(configuration.from)
    && (!configuration.tlsServername || /^[^\s\u0000-\u001f\u007f]+$/u.test(configuration.tlsServername))
    && (!configuration.replyTo || isPlainEmailAddress(configuration.replyTo))
  );

  if (!authIsPaired || !tlsModeIsValid || !valuesAreValid || !enabledValuesAreValid) {
    throw new SmtpMailError("SMTP_CONFIGURATION_INVALID", "SMTP 邮件配置无效。");
  }
};

const validateRecipients = (recipients: readonly string[] | undefined, required: boolean): void => {
  if ((required && (!recipients || recipients.length === 0)) || (recipients?.length ?? 0) > MAX_RECIPIENTS_PER_FIELD) {
    throw new SmtpMailError("SMTP_MESSAGE_INVALID", "邮件收件人配置无效。");
  }
  for (const recipient of recipients ?? []) {
    if (recipient.length > MAX_HEADER_LENGTH || !isPlainEmailAddress(recipient)) {
      throw new SmtpMailError("SMTP_MESSAGE_INVALID", "邮件收件人配置无效。");
    }
  }
};

const toTransportMessage = (configuration: SmtpMailConfiguration, message: MailMessage): SmtpTransportMessage => {
  validateRecipients(message.to, true);
  validateRecipients(message.bcc, false);
  if (message.subject.length > MAX_SUBJECT_LENGTH || hasHeaderBreak(message.subject)) {
    throw new SmtpMailError("SMTP_MESSAGE_INVALID", "邮件主题无效。");
  }

  const common = {
    from: configuration.from as string,
    ...(configuration.replyTo ? { replyTo: configuration.replyTo } : {}),
    to: [...message.to],
    ...(message.bcc?.length ? { bcc: [...message.bcc] } : {}),
    subject: message.subject,
    disableFileAccess: true as const,
    disableUrlAccess: true as const,
  };
  return message.content.format === "html"
    ? { ...common, html: message.content.body }
    : { ...common, text: message.content.body };
};

@Injectable()
export class SmtpMailGateway implements OnApplicationShutdown {
  private transport: SmtpTransport | undefined;

  constructor(
    @Inject(SMTP_MAIL_CONFIGURATION)
    private readonly configuration: SmtpMailConfiguration,
    @Inject(SMTP_TRANSPORT_FACTORY)
    private readonly transportFactory: SmtpTransportFactory
  ) {
    validateConfiguration(configuration);
  }

  async send(message: MailMessage): Promise<MailDeliveryResult> {
    if (!this.configuration.enabled) {
      throw new SmtpMailError("SMTP_DISABLED", "SMTP 邮件发送未启用。");
    }
    try {
      return await this.getTransport().sendMail(toTransportMessage(this.configuration, message));
    } catch (error) {
      if (error instanceof SmtpMailError) throw error;
      throw new SmtpMailError("SMTP_SEND_FAILED", "邮件发送失败，请稍后重试。");
    }
  }

  async verify(): Promise<SmtpVerificationResult> {
    if (!this.configuration.enabled) return { available: false, code: "SMTP_DISABLED" };
    try {
      return await this.getTransport().verify()
        ? { available: true, code: "SMTP_OK" }
        : { available: false, code: "SMTP_UNAVAILABLE" };
    } catch {
      return { available: false, code: "SMTP_UNAVAILABLE" };
    }
  }

  onApplicationShutdown(): void {
    this.transport?.close();
    this.transport = undefined;
  }

  private getTransport(): SmtpTransport {
    this.transport ??= this.transportFactory.create(this.configuration);
    return this.transport;
  }
}
