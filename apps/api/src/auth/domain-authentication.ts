export type DomainAuthenticationResult = "authenticated" | "invalid-credentials" | "unavailable";
export type DomainAuthenticationHealthStatus = "disabled" | "unknown" | "reachable" | "unavailable";

export interface DomainAuthenticationOptions {
  enabled: boolean;
  urls: string[];
  baseDn: string;
  upnSuffix: string;
  netbiosName?: string;
  accountAttribute: string;
  connectTimeoutMs: number;
  operationTimeoutMs: number;
  tlsRejectUnauthorized: boolean;
}

export interface DomainAuthenticationProvider {
  normalizeLoginName(loginName: string): string | undefined;
  authenticate(normalizedLoginName: string, password: string): Promise<DomainAuthenticationResult>;
  probeAvailability(): Promise<Exclude<DomainAuthenticationHealthStatus, "unknown">>;
  getHealthStatus(): DomainAuthenticationHealthStatus;
}

export const DOMAIN_AUTHENTICATION_OPTIONS = Symbol("DOMAIN_AUTHENTICATION_OPTIONS");
export const DOMAIN_AUTHENTICATION_PROVIDER = Symbol("DOMAIN_AUTHENTICATION_PROVIDER");

const invalidLoginCharacters = /[\u0000-\u001f\u007f]/u;

const normalizeAccountName = (accountName: string): string | undefined => {
  const normalized = accountName.trim().normalize("NFKC");
  if (!normalized || invalidLoginCharacters.test(normalized) || normalized.includes("@") || normalized.includes("\\")) {
    return undefined;
  }
  return normalized.toLocaleLowerCase("en-US");
};

/**
 * Converts a supported login form to the bare account name stored by FlowPilot.
 * A UPN or NetBIOS prefix is accepted only when it matches the deployed domain.
 */
export function normalizeConfiguredLoginName(
  loginName: string,
  options: Pick<DomainAuthenticationOptions, "upnSuffix" | "netbiosName">,
): string | undefined {
  const normalizedInput = loginName.trim().normalize("NFKC");
  if (!normalizedInput || invalidLoginCharacters.test(normalizedInput)) return undefined;

  const netbiosSeparator = normalizedInput.indexOf("\\");
  if (netbiosSeparator >= 0) {
    if (netbiosSeparator !== normalizedInput.lastIndexOf("\\") || normalizedInput.includes("@")) return undefined;
    const configuredNetbiosName = options.netbiosName?.trim();
    if (!configuredNetbiosName) return undefined;
    const suppliedNetbiosName = normalizedInput.slice(0, netbiosSeparator).trim();
    if (suppliedNetbiosName.localeCompare(configuredNetbiosName, "en-US", { sensitivity: "accent" }) !== 0) {
      return undefined;
    }
    return normalizeAccountName(normalizedInput.slice(netbiosSeparator + 1));
  }

  const upnSeparator = normalizedInput.indexOf("@");
  if (upnSeparator >= 0) {
    if (upnSeparator !== normalizedInput.lastIndexOf("@")) return undefined;
    const configuredUpnSuffix = options.upnSuffix.trim();
    if (!configuredUpnSuffix) return undefined;
    const suppliedUpnSuffix = normalizedInput.slice(upnSeparator + 1).trim();
    if (suppliedUpnSuffix.localeCompare(configuredUpnSuffix, "en-US", { sensitivity: "accent" }) !== 0) {
      return undefined;
    }
    return normalizeAccountName(normalizedInput.slice(0, upnSeparator));
  }

  return normalizeAccountName(normalizedInput);
}

const validateLdapUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("域认证地址配置无效。");
  }
  if (
    !["ldap:", "ldaps:"].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || (parsed.pathname && parsed.pathname !== "/")
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("域认证地址配置无效。");
  }
  return `${parsed.protocol}//${parsed.host}`;
};

export function parseDomainAuthenticationUrls(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(
    value
      .split(/[;,\r\n]+/u)
      .map((item) => item.trim())
      .filter(Boolean)
      .map(validateLdapUrl),
  )];
}
