import { Module, RequestMethod } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import { AuthModule } from "./auth/auth.module.js";
import { resolveTraceId } from "./common/http/request-context.middleware.js";
import { ProblemDetailsFilter } from "./common/http/problem-details.filter.js";
import { CsrfOriginGuard } from "./common/security/csrf-origin.guard.js";
import { FlowPilotConfigModule } from "./config/config.module.js";
import type { AppEnvironment } from "./config/environment.js";
import { DatabaseModule } from "./database/index.js";
import { DirectoryModule } from "./directory/directory.module.js";
import { HealthModule } from "./health/health.module.js";
import { MailModule, type SmtpMailConfiguration } from "./mail/index.js";

@Module({
  imports: [
    FlowPilotConfigModule,
    LoggerModule.forRoot({
      forRoutes: [{ path: "{*path}", method: RequestMethod.ALL }],
      pinoHttp: {
        level: process.env.NODE_ENV === "production" ? "info" : "debug",
        genReqId: (request, response) => {
          const tracedRequest = request as typeof request & { traceId?: string };
          const traceId = resolveTraceId(request.headers["x-request-id"], tracedRequest.traceId);
          tracedRequest.traceId = traceId;
          response.setHeader("X-Request-Id", traceId);
          return traceId;
        },
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "req.body.password",
            "req.body.newPassword",
            "req.body.initialPassword",
            "res.headers.set-cookie",
            "password",
            "newPassword",
            "initialPassword",
            "MSSQL_PASSWORD",
            "SMTP_PASSWORD",
            "FLOWPILOT_BOOTSTRAP_ADMIN_PASSWORD"
          ],
          censor: "[REDACTED]"
        }
      }
    }),
    DatabaseModule,
    AuthModule,
    DirectoryModule,
    MailModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnvironment, true>): SmtpMailConfiguration => ({
        enabled: config.get("SMTP_ENABLED", { infer: true }),
        host: config.get("SMTP_HOST", { infer: true }),
        port: config.get("SMTP_PORT", { infer: true }),
        secure: config.get("SMTP_SECURE", { infer: true }),
        requireTls: config.get("SMTP_REQUIRE_TLS", { infer: true }),
        ignoreTls: config.get("SMTP_IGNORE_TLS", { infer: true }),
        tlsRejectUnauthorized: config.get("SMTP_TLS_REJECT_UNAUTHORIZED", { infer: true }),
        tlsServername: config.get("SMTP_TLS_SERVERNAME", { infer: true }),
        username: config.get("SMTP_USER", { infer: true }),
        password: config.get("SMTP_PASSWORD", { infer: true }),
        from: config.get("SMTP_FROM", { infer: true }),
        replyTo: config.get("SMTP_REPLY_TO", { infer: true }),
        connectionTimeoutMs: config.get("SMTP_CONNECTION_TIMEOUT_MS", { infer: true }),
        greetingTimeoutMs: config.get("SMTP_GREETING_TIMEOUT_MS", { infer: true }),
        socketTimeoutMs: config.get("SMTP_SOCKET_TIMEOUT_MS", { infer: true }),
        maxConnections: config.get("SMTP_MAX_CONNECTIONS", { infer: true })
      })
    }),
    HealthModule
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_GUARD, useClass: CsrfOriginGuard }
  ]
})
export class AppModule {}
