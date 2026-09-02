interface AppLocationLike {
  pathname: string;
  search: string;
  hash: string;
}

interface LoginLocationState {
  returnTo?: unknown;
}

export const currentAppPath = ({ pathname, search, hash }: AppLocationLike) =>
  `${pathname}${search}${hash}`;

export const safeLoginReturnPath = (state: unknown, fallback = "/tasks") => {
  if (!state || typeof state !== "object") return fallback;
  const { returnTo } = state as LoginLocationState;
  if (typeof returnTo !== "string"
    || !returnTo.startsWith("/")
    || returnTo.startsWith("//")
    || returnTo.includes("\\")) return fallback;

  try {
    const parsed = new URL(returnTo, "https://flowpilot.invalid");
    if (parsed.origin !== "https://flowpilot.invalid" || parsed.pathname === "/login") return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
};
