import { Inject, Injectable } from "@nestjs/common";
import {
  Client,
  Filter,
  InvalidCredentialsError,
  type ClientOptions,
  type SearchOptions,
} from "ldapts";
import {
  DOMAIN_AUTHENTICATION_OPTIONS,
  type DomainAuthenticationHealthStatus,
  type DomainAuthenticationOptions,
  type DomainAuthenticationProvider,
  type DomainAuthenticationResult,
  normalizeConfiguredLoginName,
} from "./domain-authentication.js";

export interface LdapClientConnection {
  bind(bindDn: string, password: string): Promise<void>;
  search(baseDn: string, options: SearchOptions): Promise<{ searchEntries: readonly unknown[] }>;
  unbind(): Promise<void>;
}

export interface LdapClientFactory {
  create(options: ClientOptions): LdapClientConnection;
}

export const LDAP_CLIENT_FACTORY = Symbol("LDAP_CLIENT_FACTORY");
export const DOMAIN_AVAILABILITY_PROBE_TTL_MS = 5_000;

class LdapTsClientConnection implements LdapClientConnection {
  constructor(private readonly client: Client) {}

  bind(bindDn: string, password: string): Promise<void> {
    return this.client.bind(bindDn, password);
  }

  async search(baseDn: string, options: SearchOptions): Promise<{ searchEntries: readonly unknown[] }> {
    const result = await this.client.search(baseDn, options);
    return { searchEntries: result.searchEntries };
  }

  unbind(): Promise<void> {
    return this.client.unbind();
  }
}

@Injectable()
export class LdapTsClientFactory implements LdapClientFactory {
  create(options: ClientOptions): LdapClientConnection {
    return new LdapTsClientConnection(new Client(options));
  }
}

const accountAttributePattern = /^[A-Za-z][A-Za-z0-9-]*$/u;

export function escapeLdapFilterValue(value: string): string {
  return Filter.escape(value);
}

const isInvalidCredentialsError = (error: unknown): boolean => (
  error instanceof InvalidCredentialsError
  || (error instanceof Error && error.name === "InvalidCredentialsError")
);

@Injectable()
export class LdapDomainAuthenticationProvider implements DomainAuthenticationProvider {
  private healthStatus: DomainAuthenticationHealthStatus;
  private availabilityProbeInFlight: Promise<Exclude<DomainAuthenticationHealthStatus, "unknown">> | undefined;
  private cachedAvailability: Exclude<DomainAuthenticationHealthStatus, "disabled" | "unknown"> | undefined;
  private cachedAvailabilityExpiresAt = 0;
  private availabilityGeneration = 0;
  private committedAvailabilityGeneration = 0;
  private committedAvailability: "reachable" | "unavailable" | undefined;

  constructor(
    @Inject(DOMAIN_AUTHENTICATION_OPTIONS) private readonly options: DomainAuthenticationOptions,
    @Inject(LDAP_CLIENT_FACTORY) private readonly clientFactory: LdapClientFactory,
  ) {
    if (!accountAttributePattern.test(options.accountAttribute)) {
      throw new Error("域认证账号属性配置无效。");
    }
    this.healthStatus = options.enabled ? "unknown" : "disabled";
  }

  normalizeLoginName(loginName: string): string | undefined {
    return normalizeConfiguredLoginName(loginName, this.options);
  }

  getHealthStatus(): DomainAuthenticationHealthStatus {
    return this.healthStatus;
  }

  probeAvailability(): Promise<Exclude<DomainAuthenticationHealthStatus, "unknown">> {
    if (!this.options.enabled) {
      this.healthStatus = "disabled";
      return Promise.resolve("disabled");
    }

    const cachedAvailability = this.getCachedAvailability();
    if (cachedAvailability) return Promise.resolve(cachedAvailability);
    if (this.availabilityProbeInFlight) return this.availabilityProbeInFlight;

    const generation = ++this.availabilityGeneration;
    const probe = this.executeAvailabilityProbe()
      .then((status) => this.commitAvailability(status, generation, true))
      .finally(() => {
        if (this.availabilityProbeInFlight === probe) this.availabilityProbeInFlight = undefined;
      });
    this.availabilityProbeInFlight = probe;
    return probe;
  }

  async authenticate(normalizedLoginName: string, password: string): Promise<DomainAuthenticationResult> {
    if (!this.options.enabled || !this.options.urls.length || !this.options.baseDn || !this.options.upnSuffix) {
      this.healthStatus = this.options.enabled ? "unavailable" : "disabled";
      return "unavailable";
    }
    if (this.getCachedAvailability() === "unavailable") {
      this.healthStatus = "unavailable";
      return "unavailable";
    }
    const bindUpn = `${normalizedLoginName}@${this.options.upnSuffix}`;
    const filter = `(&(objectCategory=person)(objectClass=user)(${this.options.accountAttribute}=${escapeLdapFilterValue(normalizedLoginName)})(userPrincipalName=${escapeLdapFilterValue(bindUpn)}))`;

    for (const url of this.options.urls) {
      let client: LdapClientConnection | undefined;
      try {
        client = this.clientFactory.create({
          url,
          connectTimeout: this.options.connectTimeoutMs,
          timeout: this.options.operationTimeoutMs,
          tlsOptions: { rejectUnauthorized: this.options.tlsRejectUnauthorized },
          autoRebind: false,
        });
        await client.bind(bindUpn, password);
        const result = await client.search(this.options.baseDn, {
          scope: "sub",
          filter,
          attributes: ["cn", this.options.accountAttribute, "userPrincipalName"],
          sizeLimit: 2,
        });
        if (result.searchEntries.length === 1) {
          this.commitAvailability("reachable", ++this.availabilityGeneration, true);
          return "authenticated";
        }
        this.commitAvailability("unavailable", ++this.availabilityGeneration, false);
        return "invalid-credentials";
      } catch (error) {
        if (isInvalidCredentialsError(error)) {
          this.commitAvailability("reachable", ++this.availabilityGeneration, true);
          return "invalid-credentials";
        }
      } finally {
        if (client) {
          try {
            await client.unbind();
          } catch {
            // Closing a failed or already closed connection must not replace the authentication outcome.
          }
        }
      }
    }

    this.commitAvailability("unavailable", ++this.availabilityGeneration, true);
    return "unavailable";
  }

  private getCachedAvailability(): "reachable" | "unavailable" | undefined {
    if (!this.cachedAvailability) return undefined;
    if (Date.now() < this.cachedAvailabilityExpiresAt) return this.cachedAvailability;
    this.cachedAvailability = undefined;
    this.cachedAvailabilityExpiresAt = 0;
    return undefined;
  }

  private commitAvailability(
    status: "reachable" | "unavailable",
    generation: number,
    cache: boolean,
  ): "reachable" | "unavailable" {
    if (generation < this.committedAvailabilityGeneration) {
      return this.committedAvailability ?? status;
    }
    this.committedAvailabilityGeneration = generation;
    this.committedAvailability = status;
    this.healthStatus = status;
    if (cache) {
      this.cachedAvailability = status;
      this.cachedAvailabilityExpiresAt = Date.now() + DOMAIN_AVAILABILITY_PROBE_TTL_MS;
    } else {
      this.cachedAvailability = undefined;
      this.cachedAvailabilityExpiresAt = 0;
    }
    return status;
  }

  private async executeAvailabilityProbe(): Promise<"reachable" | "unavailable"> {
    if (!this.options.urls.length) return "unavailable";

    for (const url of this.options.urls) {
      let client: LdapClientConnection | undefined;
      try {
        client = this.clientFactory.create({
          url,
          connectTimeout: this.options.connectTimeoutMs,
          timeout: this.options.operationTimeoutMs,
          tlsOptions: { rejectUnauthorized: this.options.tlsRejectUnauthorized },
          autoRebind: false,
        });
        await client.search("", {
          scope: "base",
          filter: "(objectClass=*)",
          attributes: ["defaultNamingContext", "namingContexts"],
          sizeLimit: 1,
        });
        return "reachable";
      } catch {
        // Only a successful RootDSE search proves this health path is usable.
      } finally {
        if (client) {
          try {
            await client.unbind();
          } catch {
            // Cleanup does not change whether the server answered the RootDSE request.
          }
        }
      }
    }

    return "unavailable";
  }
}
