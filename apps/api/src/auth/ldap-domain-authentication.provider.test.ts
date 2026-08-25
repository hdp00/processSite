import { InvalidCredentialsError, NoSuchObjectError, type ClientOptions, type SearchOptions } from "ldapts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeConfiguredLoginName,
  parseDomainAuthenticationUrls,
  type DomainAuthenticationOptions,
} from "./domain-authentication.js";
import {
  DOMAIN_AVAILABILITY_PROBE_TTL_MS,
  LdapDomainAuthenticationProvider,
  type LdapClientConnection,
  type LdapClientFactory,
} from "./ldap-domain-authentication.provider.js";

afterEach(() => {
  vi.useRealTimers();
});

const domainOptions = (patch: Partial<DomainAuthenticationOptions> = {}): DomainAuthenticationOptions => ({
  enabled: true,
  urls: ["ldaps://directory-a.example.test:636", "ldaps://directory-b.example.test:636"],
  baseDn: "DC=example,DC=test",
  upnSuffix: "example.test",
  netbiosName: "EXAMPLE",
  accountAttribute: "sAMAccountName",
  connectTimeoutMs: 3_000,
  operationTimeoutMs: 5_000,
  tlsRejectUnauthorized: true,
  ...patch,
});

const connection = (patch: Partial<LdapClientConnection> = {}): LdapClientConnection => ({
  bind: vi.fn(() => Promise.resolve()),
  search: vi.fn(() => Promise.resolve({ searchEntries: [{ cn: "Alice" }] })),
  unbind: vi.fn(() => Promise.resolve()),
  ...patch,
});

class QueueClientFactory implements LdapClientFactory {
  readonly options: ClientOptions[] = [];

  constructor(private readonly clients: LdapClientConnection[]) {}

  create(options: ClientOptions): LdapClientConnection {
    this.options.push(options);
    const client = this.clients.shift();
    if (!client) throw new Error("测试 LDAP 客户端队列已空");
    return client;
  }
}

describe("domain login-name normalization", () => {
  const options = domainOptions();

  it("accepts bare, matching UPN, and matching NetBIOS forms", () => {
    expect(normalizeConfiguredLoginName(" Alice ", options)).toBe("alice");
    expect(normalizeConfiguredLoginName("ALICE@EXAMPLE.TEST", options)).toBe("alice");
    expect(normalizeConfiguredLoginName("example\\Alice", options)).toBe("alice");
  });

  it("rejects mismatched or structurally ambiguous domain forms", () => {
    expect(normalizeConfiguredLoginName("alice@other.example", options)).toBeUndefined();
    expect(normalizeConfiguredLoginName("OTHER\\alice", options)).toBeUndefined();
    expect(normalizeConfiguredLoginName("EXAMPLE\\alice@example.test", options)).toBeUndefined();
    expect(normalizeConfiguredLoginName("alice\u0000", options)).toBeUndefined();
  });

  it("parses ordered LDAP URL lists, removes duplicates, and rejects embedded credentials", () => {
    expect(parseDomainAuthenticationUrls(
      "LDAP://directory-a.example.test:389; ldaps://directory-b.example.test:636,ldap://directory-a.example.test:389",
    )).toEqual([
      "ldap://directory-a.example.test:389",
      "ldaps://directory-b.example.test:636",
    ]);
    expect(() => parseDomainAuthenticationUrls("ldap://user:password@directory.example.test"))
      .toThrow("域认证地址配置无效");
  });
});

describe("LdapDomainAuthenticationProvider", () => {
  it("binds with the user's UPN and confirms exactly one person/user below the configured Base DN", async () => {
    const client = connection();
    const factory = new QueueClientFactory([client]);
    const provider = new LdapDomainAuthenticationProvider(domainOptions({ urls: ["ldaps://directory.example.test"] }), factory);

    expect(provider.getHealthStatus()).toBe("unknown");
    await expect(provider.authenticate("alice", "request-only-password")).resolves.toBe("authenticated");
    expect(provider.getHealthStatus()).toBe("reachable");

    expect(client.bind).toHaveBeenCalledWith("alice@example.test", "request-only-password");
    expect(client.search).toHaveBeenCalledWith("DC=example,DC=test", {
      scope: "sub",
      filter: "(&(objectCategory=person)(objectClass=user)(sAMAccountName=alice)(userPrincipalName=alice@example.test))",
      attributes: ["cn", "sAMAccountName", "userPrincipalName"],
      sizeLimit: 2,
    });
    expect(client.unbind).toHaveBeenCalledOnce();
    expect(factory.options).toEqual([{
      url: "ldaps://directory.example.test",
      connectTimeout: 3_000,
      timeout: 5_000,
      tlsOptions: { rejectUnauthorized: true },
      autoRebind: false,
    }]);
  });

  it("RFC 4515-escapes the account value before building the search filter", async () => {
    const search = vi.fn((_baseDn: string, _options: SearchOptions) => Promise.resolve({ searchEntries: [] }));
    const client = connection({ search });
    const provider = new LdapDomainAuthenticationProvider(
      domainOptions({ urls: ["ldap://directory.example.test"] }),
      new QueueClientFactory([client]),
    );

    await expect(provider.authenticate("alice*)(sAMAccountName=*)", "request-only-password"))
      .resolves.toBe("invalid-credentials");

    expect(search).toHaveBeenCalledWith("DC=example,DC=test", expect.objectContaining({
      filter: "(&(objectCategory=person)(objectClass=user)(sAMAccountName=alice\\2a\\29\\28sAMAccountName=\\2a\\29)(userPrincipalName=alice\\2a\\29\\28sAMAccountName=\\2a\\29@example.test))",
    }));
    expect(provider.getHealthStatus()).toBe("unavailable");
  });

  it("returns invalid credentials without trying another server when the bind is rejected", async () => {
    const rejected = connection({
      bind: vi.fn(() => Promise.reject(new InvalidCredentialsError())),
    });
    const unused = connection();
    const factory = new QueueClientFactory([rejected, unused]);
    const provider = new LdapDomainAuthenticationProvider(domainOptions(), factory);

    await expect(provider.authenticate("alice", "wrong-password")).resolves.toBe("invalid-credentials");

    expect(provider.getHealthStatus()).toBe("reachable");
    expect(factory.options).toHaveLength(1);
    expect(rejected.unbind).toHaveBeenCalledOnce();
    expect(unused.bind).not.toHaveBeenCalled();
  });

  it("tries the configured URLs in order after infrastructure failures", async () => {
    const unavailable = connection({ bind: vi.fn(() => Promise.reject(new Error("connection failed"))) });
    const available = connection();
    const factory = new QueueClientFactory([unavailable, available]);
    const provider = new LdapDomainAuthenticationProvider(domainOptions(), factory);

    await expect(provider.authenticate("alice", "request-only-password")).resolves.toBe("authenticated");

    expect(factory.options.map((options) => options.url)).toEqual([
      "ldaps://directory-a.example.test:636",
      "ldaps://directory-b.example.test:636",
    ]);
    expect(unavailable.unbind).toHaveBeenCalledOnce();
    expect(available.unbind).toHaveBeenCalledOnce();
  });

  it("returns unavailable after every configured URL fails and ignores cleanup failures", async () => {
    const first = connection({
      bind: vi.fn(() => Promise.reject(new Error("timeout"))),
      unbind: vi.fn(() => Promise.reject(new Error("already closed"))),
    });
    const second = connection({ bind: vi.fn(() => Promise.reject(new Error("certificate rejected"))) });
    const provider = new LdapDomainAuthenticationProvider(domainOptions(), new QueueClientFactory([first, second]));

    await expect(provider.authenticate("alice", "request-only-password")).resolves.toBe("unavailable");
    expect(provider.getHealthStatus()).toBe("unavailable");
  });

  it("does not report authentication healthy after a non-credential LDAP result-code error", async () => {
    const responded = connection({
      search: vi.fn(() => Promise.reject(new NoSuchObjectError())),
    });
    const unavailable = connection({ bind: vi.fn(() => Promise.reject(new Error("timeout"))) });
    const provider = new LdapDomainAuthenticationProvider(
      domainOptions(),
      new QueueClientFactory([responded, unavailable]),
    );

    await expect(provider.authenticate("alice", "request-only-password")).resolves.toBe("unavailable");
    expect(provider.getHealthStatus()).toBe("unavailable");
  });

  it("performs an anonymous RootDSE base search and caches the availability for a short TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
    const first = connection();
    const second = connection();
    const factory = new QueueClientFactory([first, second]);
    const provider = new LdapDomainAuthenticationProvider(
      domainOptions({ urls: ["ldaps://directory.example.test"] }),
      factory,
    );

    await expect(provider.probeAvailability()).resolves.toBe("reachable");
    await expect(provider.probeAvailability()).resolves.toBe("reachable");
    vi.advanceTimersByTime(DOMAIN_AVAILABILITY_PROBE_TTL_MS - 1);
    await expect(provider.probeAvailability()).resolves.toBe("reachable");

    expect(factory.options).toHaveLength(1);
    expect(first.bind).not.toHaveBeenCalled();
    expect(first.search).toHaveBeenCalledWith("", {
      scope: "base",
      filter: "(objectClass=*)",
      attributes: ["defaultNamingContext", "namingContexts"],
      sizeLimit: 1,
    });

    vi.advanceTimersByTime(2);
    await expect(provider.probeAvailability()).resolves.toBe("reachable");
    expect(factory.options).toHaveLength(2);
    expect(second.bind).not.toHaveBeenCalled();
  });

  it("coalesces concurrent availability probes into one RootDSE request", async () => {
    let resolveSearch: ((value: { searchEntries: readonly unknown[] }) => void) | undefined;
    const pendingSearch = new Promise<{ searchEntries: readonly unknown[] }>((resolve) => {
      resolveSearch = resolve;
    });
    const client = connection({ search: vi.fn(() => pendingSearch) });
    const factory = new QueueClientFactory([client]);
    const provider = new LdapDomainAuthenticationProvider(
      domainOptions({ urls: ["ldap://directory.example.test"] }),
      factory,
    );

    const firstProbe = provider.probeAvailability();
    const secondProbe = provider.probeAvailability();
    expect(factory.options).toHaveLength(1);

    resolveSearch?.({ searchEntries: [{}] });
    await expect(Promise.all([firstProbe, secondProbe])).resolves.toEqual(["reachable", "reachable"]);
    expect(client.search).toHaveBeenCalledOnce();
  });

  it("does not let an older probe overwrite a newer authentication result", async () => {
    let rejectProbe: ((reason?: unknown) => void) | undefined;
    const pendingProbe = new Promise<{ searchEntries: readonly unknown[] }>((_resolve, reject) => {
      rejectProbe = reject;
    });
    const probeClient = connection({ search: vi.fn(() => pendingProbe) });
    const authenticationClient = connection();
    const provider = new LdapDomainAuthenticationProvider(
      domainOptions({ urls: ["ldaps://directory.example.test:636"] }),
      new QueueClientFactory([probeClient, authenticationClient]),
    );

    const probe = provider.probeAvailability();
    await expect(provider.authenticate("alice", "request-only-password")).resolves.toBe("authenticated");
    rejectProbe?.(new Error("older probe failed"));
    await expect(probe).resolves.toBe("reachable");

    expect(provider.getHealthStatus()).toBe("reachable");
  });

  it("does not report a failed RootDSE result-code response as healthy", async () => {
    const client = connection({ search: vi.fn(() => Promise.reject(new NoSuchObjectError())) });
    const provider = new LdapDomainAuthenticationProvider(
      domainOptions({ urls: ["ldap://directory.example.test"] }),
      new QueueClientFactory([client]),
    );

    await expect(provider.probeAvailability()).resolves.toBe("unavailable");
    expect(provider.getHealthStatus()).toBe("unavailable");
    expect(client.bind).not.toHaveBeenCalled();
  });

  it("reports the RootDSE probe unavailable only after every address has infrastructure failures", async () => {
    const first = connection({ search: vi.fn(() => Promise.reject(new Error("timeout"))) });
    const second = connection({ search: vi.fn(() => Promise.reject(new Error("certificate rejected"))) });
    const provider = new LdapDomainAuthenticationProvider(
      domainOptions(),
      new QueueClientFactory([first, second]),
    );

    await expect(provider.probeAvailability()).resolves.toBe("unavailable");
    expect(provider.getHealthStatus()).toBe("unavailable");
    expect(first.bind).not.toHaveBeenCalled();
    expect(second.bind).not.toHaveBeenCalled();
  });

  it("short-circuits repeated domain binds while the shared outage cache is active", async () => {
    const failed = connection({ bind: vi.fn(() => Promise.reject(new Error("connection refused"))) });
    const unused = connection();
    const factory = new QueueClientFactory([failed, unused]);
    const provider = new LdapDomainAuthenticationProvider(
      domainOptions({ urls: ["ldap://directory.example.test"] }),
      factory,
    );

    await expect(provider.authenticate("alice", "request-only-password")).resolves.toBe("unavailable");
    await expect(provider.authenticate("alice", "request-only-password")).resolves.toBe("unavailable");

    expect(factory.options).toHaveLength(1);
    expect(unused.bind).not.toHaveBeenCalled();
  });

  it("does not open a connection when domain authentication is disabled", async () => {
    const factory = new QueueClientFactory([]);
    const provider = new LdapDomainAuthenticationProvider(domainOptions({ enabled: false }), factory);

    expect(provider.getHealthStatus()).toBe("disabled");
    await expect(provider.probeAvailability()).resolves.toBe("disabled");
    await expect(provider.authenticate("alice", "request-only-password")).resolves.toBe("unavailable");
    expect(provider.getHealthStatus()).toBe("disabled");
    expect(factory.options).toHaveLength(0);
  });

  it("rejects an unsafe account-attribute configuration before any connection is made", () => {
    expect(() => new LdapDomainAuthenticationProvider(
      domainOptions({ accountAttribute: "sAMAccountName)(objectClass=*" }),
      new QueueClientFactory([]),
    )).toThrow("域认证账号属性配置无效");
  });
});
