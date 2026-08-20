const LAST_SUCCESSFUL_LOGIN_USERNAME_KEY = "flowpilot-last-successful-login-username";

type LoginNameStorage = Pick<Storage, "getItem" | "setItem">;

export const readLastSuccessfulLoginUsername = (storage: LoginNameStorage = window.localStorage) => {
  try {
    return storage.getItem(LAST_SUCCESSFUL_LOGIN_USERNAME_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
};

export const saveLastSuccessfulLoginUsername = (
  username: string,
  storage: LoginNameStorage = window.localStorage,
) => {
  const normalizedUsername = username.trim();
  if (!normalizedUsername) return;
  try {
    storage.setItem(LAST_SUCCESSFUL_LOGIN_USERNAME_KEY, normalizedUsername);
  } catch {
    // 浏览器禁用本地存储时仍允许正常登录，仅不记忆账号名。
  }
};
