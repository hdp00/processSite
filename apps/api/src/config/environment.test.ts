import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EnvironmentValidationError,
  isUnsupportedLocalDbServer,
  resolveBundledEnvironmentDefaultsFilePath,
  resolveEnvironmentFilePaths,
  validateEnvironment
} from "./environment.js";

const validEnvironment = () => ({
  NODE_ENV: "test",
  MSSQL_SERVER: "127.0.0.1",
  MSSQL_DATABASE: "FlowPilot",
  MSSQL_USER: "flowpilot_app",
  MSSQL_PASSWORD: "not-a-real-password",
  MSSQL_EXPECTED_COLLATION: "Chinese_PRC_CI_AS",
  DOMAIN_AUTH_ENABLED: "false"
});

describe("validateEnvironment", () => {
  it("normalizes booleans and defaults without exposing secrets", () => {
    const environment = validateEnvironment(validEnvironment());

    expect(environment.MSSQL_ENCRYPT).toBe(true);
    expect(environment.MSSQL_TRUST_SERVER_CERTIFICATE).toBe(false);
    expect(environment.MSSQL_EXPECTED_COMPATIBILITY_LEVEL).toBe(130);
    expect(environment.FLOWPILOT_BUSINESS_TIME_ZONE).toBe("Asia/Shanghai");
    expect(environment.AUTH_LOGIN_GLOBAL_IN_FLIGHT_LIMIT).toBe(4);
    expect(environment.AUTH_LOGIN_IP_IN_FLIGHT_LIMIT).toBe(2);
    expect(environment.AUTH_LOGIN_UNAVAILABLE_WINDOW_MS).toBe(60_000);
    expect(environment.AUTH_LOGIN_UNAVAILABLE_IP_LIMIT).toBe(60);
    expect(environment.SMTP_ENABLED).toBe(false);
    expect(environment.SMTP_PORT).toBe(25);
    expect(environment.SMTP_MAX_CONNECTIONS).toBe(5);
    expect(environment.SMTP_IGNORE_TLS).toBe(false);
    expect(environment.SMTP_REQUIRE_TLS).toBe(true);
  });

  it("rejects listening addresses that expose NestJS beyond loopback", () => {
    expect(() => validateEnvironment({
      ...validEnvironment(),
      APP_HOST: "0.0.0.0"
    })).toThrow(EnvironmentValidationError);
  });

  it("requires LDAP settings when domain authentication is enabled", () => {
    expect(() => validateEnvironment({
      ...validEnvironment(),
      DOMAIN_AUTH_ENABLED: "true"
    })).toThrow(/DOMAIN_AUTH_URLS/);
  });

  it("rejects unsafe LDAP URLs and accepts ordered LDAP/LDAPS endpoints", () => {
    expect(() => validateEnvironment({
      ...validEnvironment(),
      DOMAIN_AUTH_ENABLED: "true",
      DOMAIN_AUTH_URLS: "ldap://user:password@directory.example.test/DC=example;ldaps://backup.example.test",
      DOMAIN_AUTH_BASE_DN: "DC=example,DC=test",
      DOMAIN_AUTH_UPN_SUFFIX: "example.test"
    })).toThrow(/LDAP 地址/);

    expect(() => validateEnvironment({
      ...validEnvironment(),
      DOMAIN_AUTH_ENABLED: "true",
      DOMAIN_AUTH_URLS: "ldap://directory.example.test;ldaps://backup.example.test:636",
      DOMAIN_AUTH_BASE_DN: "DC=example,DC=test",
      DOMAIN_AUTH_UPN_SUFFIX: "example.test"
    })).toThrow(/DOMAIN_AUTH_ALLOW_PLAINTEXT/);

    expect(() => validateEnvironment({
      ...validEnvironment(),
      DOMAIN_AUTH_ENABLED: "true",
      DOMAIN_AUTH_URLS: "ldap:\t//directory.example.test",
      DOMAIN_AUTH_BASE_DN: "DC=example,DC=test",
      DOMAIN_AUTH_UPN_SUFFIX: "example.test"
    })).toThrow(/DOMAIN_AUTH_ALLOW_PLAINTEXT/);

    const environment = validateEnvironment({
      ...validEnvironment(),
      DOMAIN_AUTH_ENABLED: "true",
      DOMAIN_AUTH_URLS: "ldap://directory.example.test;ldaps://backup.example.test:636",
      DOMAIN_AUTH_BASE_DN: "DC=example,DC=test",
      DOMAIN_AUTH_UPN_SUFFIX: "example.test",
      DOMAIN_AUTH_ALLOW_PLAINTEXT: "true"
    });
    expect(environment.DOMAIN_AUTH_URLS).toContain("ldaps://");
  });

  it("requires SMTP endpoints and paired credentials only when SMTP is enabled", () => {
    expect(() => validateEnvironment({
      ...validEnvironment(),
      SMTP_ENABLED: "true"
    })).toThrow(/SMTP_HOST/);

    expect(() => validateEnvironment({
      ...validEnvironment(),
      SMTP_USER: "mailer"
    })).toThrow(/SMTP_PASSWORD/);

    const environment = validateEnvironment({
      ...validEnvironment(),
      SMTP_ENABLED: "true",
      SMTP_HOST: "smtp.example.test",
      SMTP_FROM: "flowpilot@example.test",
      SMTP_USER: "mailer",
      SMTP_PASSWORD: "not-a-real-password"
    });
    expect(environment.SMTP_SOCKET_TIMEOUT_MS).toBe(15_000);

    expect(() => validateEnvironment({
      ...validEnvironment(),
      SMTP_REQUIRE_TLS: "true",
      SMTP_IGNORE_TLS: "true"
    })).toThrow(/SMTP_IGNORE_TLS/);

    expect(() => validateEnvironment({
      ...validEnvironment(),
      SMTP_ENABLED: "true",
      SMTP_HOST: "smtp.example.test",
      SMTP_FROM: "flowpilot@example.test",
      SMTP_REQUIRE_TLS: "false",
      SMTP_IGNORE_TLS: "false"
    })).toThrow(/SMTP_REQUIRE_TLS/);

    expect(validateEnvironment({
      ...validEnvironment(),
      SMTP_ENABLED: "true",
      SMTP_HOST: "smtp.example.test",
      SMTP_FROM: "flowpilot@example.test",
      SMTP_REQUIRE_TLS: "false",
      SMTP_IGNORE_TLS: "true"
    }).SMTP_IGNORE_TLS).toBe(true);
  });
});

describe("isUnsupportedLocalDbServer", () => {
  it("identifies LocalDB while allowing TCP SQL Server hosts", () => {
    expect(isUnsupportedLocalDbServer("(localdb)\\MSSQLLocalDB")).toBe(true);
    expect(isUnsupportedLocalDbServer("sql01.internal.example")).toBe(false);
  });
});

describe("production environment template", () => {
  it("quotes every secret placeholder so # and spaces are not truncated by dotenv", () => {
    const example = readFileSync(new URL("../../config/production.env.example", import.meta.url), "utf8");

    for (const key of [
      "MSSQL_PASSWORD",
      "SMTP_PASSWORD",
      "FLOWPILOT_BOOTSTRAP_ADMIN_PASSWORD"
    ]) {
      expect(example).toMatch(new RegExp(`^${key}='[^']+'$`, "mu"));
    }
  });
});

describe("bundled environment defaults", () => {
  it("loads bundled defaults after both external override files", () => {
    const defaultsPath = resolveBundledEnvironmentDefaultsFilePath();
    const paths = resolveEnvironmentFilePaths();

    expect(defaultsPath.replaceAll("\\", "/")).toMatch(/apps\/api\/config\/defaults\.env$/u);
    expect(paths.at(-1)).toBe(defaultsPath);
  });

  it("contains only stable non-secret settings", () => {
    const defaults = readFileSync(resolveBundledEnvironmentDefaultsFilePath(), "utf8");

    expect(defaults).toMatch(/^MSSQL_EXPECTED_COMPATIBILITY_LEVEL=130$/mu);
    expect(defaults).toMatch(/^DOMAIN_AUTH_ALLOW_PLAINTEXT=false$/mu);
    expect(defaults).toMatch(/^SMTP_REQUIRE_TLS=true$/mu);

    for (const key of [
      "FLOWPILOT_BOOTSTRAP_ADMIN_PASSWORD",
      "MSSQL_SERVER",
      "MSSQL_DATABASE",
      "MSSQL_USER",
      "MSSQL_PASSWORD",
      "MSSQL_EXPECTED_COLLATION",
      "DOMAIN_AUTH_URLS",
      "DOMAIN_AUTH_BASE_DN",
      "DOMAIN_AUTH_UPN_SUFFIX",
      "SMTP_HOST",
      "SMTP_USER",
      "SMTP_PASSWORD",
      "SMTP_FROM"
    ]) {
      expect(defaults).not.toMatch(new RegExp(`^${key}=`, "mu"));
    }
  });
});
