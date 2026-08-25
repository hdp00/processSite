import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DatabaseModule } from "../database/index.js";
import type { AppEnvironment } from "../config/environment.js";
import { AuthController } from "./auth.controller.js";
import { AUTH_PERSISTENCE } from "./auth.persistence.js";
import { AuthService } from "./auth.service.js";
import {
  DOMAIN_AUTHENTICATION_OPTIONS,
  DOMAIN_AUTHENTICATION_PROVIDER,
  parseDomainAuthenticationUrls,
  type DomainAuthenticationOptions,
} from "./domain-authentication.js";
import {
  LDAP_CLIENT_FACTORY,
  LdapDomainAuthenticationProvider,
  LdapTsClientFactory,
} from "./ldap-domain-authentication.provider.js";
import { SessionGuard } from "./session.guard.js";
import {
  LOGIN_RATE_LIMIT_OPTIONS,
  LoginRateLimiter,
  type LoginRateLimitOptions,
} from "./login-rate-limiter.js";
import { TypeOrmAuthPersistence } from "./typeorm-auth.persistence.js";

@Module({
  imports: [DatabaseModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    LoginRateLimiter,
    LdapTsClientFactory,
    { provide: LDAP_CLIENT_FACTORY, useExisting: LdapTsClientFactory },
    LdapDomainAuthenticationProvider,
    { provide: DOMAIN_AUTHENTICATION_PROVIDER, useExisting: LdapDomainAuthenticationProvider },
    {
      provide: DOMAIN_AUTHENTICATION_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnvironment, true>): DomainAuthenticationOptions => {
        const netbiosName = config.get("DOMAIN_AUTH_NETBIOS_NAME", { infer: true });
        return {
          enabled: config.get("DOMAIN_AUTH_ENABLED", { infer: true }),
          urls: parseDomainAuthenticationUrls(config.get("DOMAIN_AUTH_URLS", { infer: true })),
          baseDn: config.get("DOMAIN_AUTH_BASE_DN", { infer: true }) ?? "",
          upnSuffix: config.get("DOMAIN_AUTH_UPN_SUFFIX", { infer: true }) ?? "",
          ...(netbiosName ? { netbiosName } : {}),
          accountAttribute: config.get("DOMAIN_AUTH_ACCOUNT_ATTRIBUTE", { infer: true }),
          connectTimeoutMs: config.get("DOMAIN_AUTH_CONNECT_TIMEOUT_MS", { infer: true }),
          operationTimeoutMs: config.get("DOMAIN_AUTH_OPERATION_TIMEOUT_MS", { infer: true }),
          tlsRejectUnauthorized: config.get("DOMAIN_AUTH_TLS_REJECT_UNAUTHORIZED", { infer: true }),
        };
      },
    },
    {
      provide: LOGIN_RATE_LIMIT_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnvironment, true>): LoginRateLimitOptions => ({
        windowMs: config.get("AUTH_LOGIN_FAILURE_WINDOW_MS", { infer: true }),
        blockMs: config.get("AUTH_LOGIN_BLOCK_DURATION_MS", { infer: true }),
        accountIpFailureLimit: config.get("AUTH_LOGIN_ACCOUNT_IP_FAILURE_LIMIT", { infer: true }),
        ipFailureLimit: config.get("AUTH_LOGIN_IP_FAILURE_LIMIT", { infer: true }),
        unavailableWindowMs: config.get("AUTH_LOGIN_UNAVAILABLE_WINDOW_MS", { infer: true }),
        unavailableBlockMs: config.get("AUTH_LOGIN_UNAVAILABLE_BLOCK_DURATION_MS", { infer: true }),
        unavailableIpLimit: config.get("AUTH_LOGIN_UNAVAILABLE_IP_LIMIT", { infer: true }),
        globalInFlightLimit: config.get("AUTH_LOGIN_GLOBAL_IN_FLIGHT_LIMIT", { infer: true }),
        ipInFlightLimit: config.get("AUTH_LOGIN_IP_IN_FLIGHT_LIMIT", { infer: true }),
      }),
    },
    SessionGuard,
    TypeOrmAuthPersistence,
    { provide: AUTH_PERSISTENCE, useExisting: TypeOrmAuthPersistence },
  ],
  exports: [AuthService, SessionGuard, DOMAIN_AUTHENTICATION_PROVIDER],
})
export class AuthModule {}
