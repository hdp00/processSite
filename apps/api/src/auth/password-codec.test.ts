import { scrypt } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hashPassword,
  SCRYPT_PASSWORD_PARAMETERS,
  verifyPassword,
  verifyPasswordDetailed,
} from "./password-codec.js";

const legacyHash = async (password: string): Promise<string> => {
  const salt = Buffer.alloc(16, 0x3c);
  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, value) => {
      if (error) reject(error);
      else resolve(Buffer.from(value));
    });
  });
  return `flowpilot-scrypt$v1$N=32768,r=8,p=1,maxmem=67108864$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
};

describe("password codec", () => {
  it("encodes the fixed version and complete scrypt parameters", async () => {
    const encoded = await hashPassword("unit-test-password");
    const segments = encoded.split("$");

    expect(segments.slice(0, 3)).toEqual([
      "flowpilot-scrypt",
      "v1",
      "N=65536,r=8,p=1,maxmem=100663296",
    ]);
    expect(Buffer.from(segments[3] ?? "", "base64url")).toHaveLength(16);
    expect(Buffer.from(segments[4] ?? "", "base64url")).toHaveLength(32);
    expect(SCRYPT_PASSWORD_PARAMETERS.derivedKeyBytes).toBe(32);
  });

  it("uses a random salt and verifies with a timing-safe derived-key comparison", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");

    expect(first).not.toBe(second);
    await expect(verifyPassword("correct horse battery staple", first)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", first)).resolves.toBe(false);
  });

  it("rejects malformed and unsupported encodings without throwing", async () => {
    await expect(verifyPassword("password", undefined)).resolves.toBe(false);
    await expect(verifyPassword("password", "flowpilot-scrypt$v2$bad$bad$bad")).resolves.toBe(false);
  });

  it("verifies safe legacy parameters and marks them for gradual rehash", async () => {
    const encoded = await legacyHash("legacy-password");

    await expect(verifyPasswordDetailed("legacy-password", encoded)).resolves.toEqual({
      matches: true,
      needsRehash: true,
    });
    await expect(verifyPasswordDetailed("wrong-password", encoded)).resolves.toEqual({
      matches: false,
      needsRehash: false,
    });
  });

  it("rejects encoded work factors above the resource ceiling", async () => {
    const salt = Buffer.alloc(16, 0x11).toString("base64url");
    const key = Buffer.alloc(32, 0x22).toString("base64url");
    const encoded = `flowpilot-scrypt$v1$N=262144,r=8,p=1,maxmem=268435456$${salt}$${key}`;

    await expect(verifyPasswordDetailed("password", encoded)).resolves.toEqual({
      matches: false,
      needsRehash: false,
    });
  });
});
