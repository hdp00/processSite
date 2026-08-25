import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const FORMAT_PREFIX = "flowpilot-scrypt";
const FORMAT_VERSION = "v1";
const SALT_BYTES = 16;
const DERIVED_KEY_BYTES = 32;
const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 0xa5);
const DUMMY_EXPECTED_KEY = Buffer.alloc(DERIVED_KEY_BYTES, 0x5a);
const MAX_ENCODED_LENGTH = 500;
const MIN_ACCEPTED_N = 16_384;
const MAX_ACCEPTED_N = 131_072;
const MIN_ACCEPTED_R = 1;
const MAX_ACCEPTED_R = 16;
const MIN_ACCEPTED_P = 1;
const MAX_ACCEPTED_P = 4;
const MIN_ACCEPTED_MAX_MEMORY = 16 * 1024 * 1024;
const MAX_ACCEPTED_MAX_MEMORY = 256 * 1024 * 1024;
const MAX_ACCEPTED_WORK_FACTOR = 2_097_152;

export interface ScryptPasswordParameters {
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

export interface PasswordVerificationResult {
  matches: boolean;
  needsRehash: boolean;
}

export const SCRYPT_PASSWORD_PARAMETERS = Object.freeze({
  N: 65_536,
  r: 8,
  p: 1,
  maxmem: 96 * 1024 * 1024,
  derivedKeyBytes: DERIVED_KEY_BYTES,
  saltBytes: SALT_BYTES,
});

interface ParsedPasswordHash {
  parameters: ScryptPasswordParameters;
  salt: Buffer;
  derivedKey: Buffer;
}

const parameterSegment = (parameters: ScryptPasswordParameters): string => (
  `N=${parameters.N},r=${parameters.r},p=${parameters.p},maxmem=${parameters.maxmem}`
);

const deriveKey = (
  password: string,
  salt: Buffer,
  parameters: ScryptPasswordParameters,
): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, DERIVED_KEY_BYTES, parameters, (error, derivedKey) => {
    if (error) reject(error);
    else resolve(Buffer.from(derivedKey));
  });
});

const parsePositiveInteger = (value: string | undefined): number | undefined => {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const safeParameters = (parameters: ScryptPasswordParameters): boolean => {
  const powerOfTwoN = parameters.N > 1 && (parameters.N & (parameters.N - 1)) === 0;
  const estimatedMemory = 128 * parameters.N * parameters.r;
  return powerOfTwoN
    && parameters.N >= MIN_ACCEPTED_N
    && parameters.N <= MAX_ACCEPTED_N
    && parameters.r >= MIN_ACCEPTED_R
    && parameters.r <= MAX_ACCEPTED_R
    && parameters.p >= MIN_ACCEPTED_P
    && parameters.p <= MAX_ACCEPTED_P
    && parameters.maxmem >= MIN_ACCEPTED_MAX_MEMORY
    && parameters.maxmem <= MAX_ACCEPTED_MAX_MEMORY
    && parameters.N * parameters.r * parameters.p <= MAX_ACCEPTED_WORK_FACTOR
    && estimatedMemory < parameters.maxmem;
};

const parseParameters = (value: string): ScryptPasswordParameters | undefined => {
  const parts = value.split(",");
  if (parts.length !== 4) return undefined;
  const entries = parts.map((part) => part.split("="));
  if (entries.some((entry) => entry.length !== 2)) return undefined;
  const values = new Map(entries.map(([key, parameterValue]) => [key, parameterValue] as const));
  if (values.size !== 4 || [...values.keys()].some((key) => !["N", "r", "p", "maxmem"].includes(key ?? ""))) {
    return undefined;
  }
  const N = parsePositiveInteger(values.get("N"));
  const r = parsePositiveInteger(values.get("r"));
  const p = parsePositiveInteger(values.get("p"));
  const maxmem = parsePositiveInteger(values.get("maxmem"));
  if (N === undefined || r === undefined || p === undefined || maxmem === undefined) return undefined;
  const parameters = { N, r, p, maxmem };
  return safeParameters(parameters) ? parameters : undefined;
};

const decodeFixedBase64Url = (value: string | undefined, length: number): Buffer | undefined => {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === length && decoded.toString("base64url") === value ? decoded : undefined;
};

const parsePasswordHash = (encoded: string): ParsedPasswordHash | undefined => {
  if (encoded.length > MAX_ENCODED_LENGTH) return undefined;
  const segments = encoded.split("$");
  if (segments.length !== 5) return undefined;
  const [prefix, version, parameterValue, saltValue, derivedKeyValue] = segments;
  if (prefix !== FORMAT_PREFIX || version !== FORMAT_VERSION || !parameterValue) return undefined;
  const parameters = parseParameters(parameterValue);
  const salt = decodeFixedBase64Url(saltValue, SALT_BYTES);
  const derivedKey = decodeFixedBase64Url(derivedKeyValue, DERIVED_KEY_BYTES);
  return parameters && salt && derivedKey ? { parameters, salt, derivedKey } : undefined;
};

const currentParameters = (): ScryptPasswordParameters => ({
  N: SCRYPT_PASSWORD_PARAMETERS.N,
  r: SCRYPT_PASSWORD_PARAMETERS.r,
  p: SCRYPT_PASSWORD_PARAMETERS.p,
  maxmem: SCRYPT_PASSWORD_PARAMETERS.maxmem,
});

const usesCurrentParameters = (parameters: ScryptPasswordParameters): boolean => (
  parameters.N === SCRYPT_PASSWORD_PARAMETERS.N
  && parameters.r === SCRYPT_PASSWORD_PARAMETERS.r
  && parameters.p === SCRYPT_PASSWORD_PARAMETERS.p
  && parameters.maxmem === SCRYPT_PASSWORD_PARAMETERS.maxmem
);

export async function hashPassword(password: string): Promise<string> {
  const parameters = currentParameters();
  const salt = randomBytes(SALT_BYTES);
  const derivedKey = await deriveKey(password, salt, parameters);
  return [
    FORMAT_PREFIX,
    FORMAT_VERSION,
    parameterSegment(parameters),
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

export async function verifyPasswordDetailed(
  password: string,
  encoded: string | undefined,
): Promise<PasswordVerificationResult> {
  const parsed = encoded ? parsePasswordHash(encoded) : undefined;
  const actual = await deriveKey(
    password,
    parsed?.salt ?? DUMMY_SALT,
    parsed?.parameters ?? currentParameters(),
  );
  const expected = parsed?.derivedKey ?? DUMMY_EXPECTED_KEY;
  const matches = timingSafeEqual(actual, expected) && parsed !== undefined;
  return {
    matches,
    needsRehash: matches && !usesCurrentParameters(parsed.parameters),
  };
}

export async function verifyPassword(password: string, encoded: string | undefined): Promise<boolean> {
  return (await verifyPasswordDetailed(password, encoded)).matches;
}
