export const SMTP_MAIL_CONFIGURATION = Symbol("SMTP_MAIL_CONFIGURATION");
export const SMTP_TRANSPORT_FACTORY = Symbol("SMTP_TRANSPORT_FACTORY");

export interface SmtpMailConfiguration {
  enabled: boolean;
  host?: string | undefined;
  port: number;
  secure: boolean;
  requireTls: boolean;
  ignoreTls: boolean;
  tlsRejectUnauthorized: boolean;
  tlsServername?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  from?: string | undefined;
  replyTo?: string | undefined;
  connectionTimeoutMs: number;
  greetingTimeoutMs: number;
  socketTimeoutMs: number;
  maxConnections: number;
}

export interface MailMessage {
  to: readonly string[];
  bcc?: readonly string[];
  subject: string;
  content:
    | { format: "text"; body: string }
    | { format: "html"; body: string };
}

export interface MailDeliveryResult {
  messageId: string | null;
  acceptedCount: number;
  rejectedCount: number;
}

export type SmtpVerificationResult =
  | { available: true; code: "SMTP_OK" }
  | { available: false; code: "SMTP_DISABLED" | "SMTP_UNAVAILABLE" };

export type SmtpMailErrorCode =
  | "SMTP_DISABLED"
  | "SMTP_CONFIGURATION_INVALID"
  | "SMTP_MESSAGE_INVALID"
  | "SMTP_SEND_FAILED";

/**
 * A deliberately small, stable error boundary for the future outbox worker.
 * Provider errors are not exposed because they can include internal hosts or accounts.
 */
export class SmtpMailError extends Error {
  constructor(
    readonly code: SmtpMailErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SmtpMailError";
  }
}

export interface SmtpTransportMessage {
  from: string;
  replyTo?: string;
  to: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  disableFileAccess: true;
  disableUrlAccess: true;
}

export interface SmtpTransportSendResult {
  messageId: string | null;
  acceptedCount: number;
  rejectedCount: number;
}

export interface SmtpTransport {
  sendMail(message: SmtpTransportMessage): Promise<SmtpTransportSendResult>;
  verify(): Promise<boolean>;
  close(): void;
}

export interface SmtpTransportFactory {
  create(configuration: SmtpMailConfiguration): SmtpTransport;
}
