let fallbackCounter = 0;

const fallbackRandomBytes = (bytes: Uint8Array) => {
  fallbackCounter += 1;
  let seed = (Date.now() ^ Math.imul(fallbackCounter, 0x9e3779b1)) >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    seed = (Math.imul(seed ^ (seed >>> 16), 0x45d9f3b) + index) >>> 0;
    bytes[index] = (seed ^ Math.floor(Math.random() * 256)) & 0xff;
  }
};

/**
 * 生成浏览器端业务标识。普通 HTTP 下 randomUUID 不可用时，优先使用
 * getRandomValues 组装 RFC 4122 v4 UUID；最后的伪随机分支仅用于业务标识，
 * 不得用于密码、会话令牌或其他安全凭据。
 */
export const createClientUuid = () => {
  const cryptoSource = globalThis.crypto;
  if (typeof cryptoSource?.randomUUID === "function") return cryptoSource.randomUUID();

  const bytes = new Uint8Array(16);
  try {
    if (typeof cryptoSource?.getRandomValues === "function") cryptoSource.getRandomValues(bytes);
    else fallbackRandomBytes(bytes);
  } catch {
    fallbackRandomBytes(bytes);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
};

