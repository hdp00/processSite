import { describe, expect, it } from "vitest";
import { readLastSuccessfulLoginUsername, saveLastSuccessfulLoginUsername } from "./lastLoginUsername";

const createStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
};

describe("lastLoginUsername", () => {
  it("只保存规范化后的最近成功登录账号", () => {
    const storage = createStorage();
    saveLastSuccessfulLoginUsername("  zhangwei  ", storage);
    expect(readLastSuccessfulLoginUsername(storage)).toBe("zhangwei");
  });

  it("忽略空账号", () => {
    const storage = createStorage();
    saveLastSuccessfulLoginUsername("lina", storage);
    saveLastSuccessfulLoginUsername("   ", storage);
    expect(readLastSuccessfulLoginUsername(storage)).toBe("lina");
  });
});
