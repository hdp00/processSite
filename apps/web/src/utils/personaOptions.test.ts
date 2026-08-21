import { describe, expect, it } from "vitest";
import { useIdentityStore } from "../state/useIdentityStore";
import { buildDebugPersonaOptions } from "./personaOptions";

describe("Debug 演示身份选项", () => {
  it("包含全部启用用户、排除停用用户，并将超级管理员固定在第一项", () => {
    const users = useIdentityStore.getState().users;
    const options = buildDebugPersonaOptions(users);

    expect(options).toHaveLength(users.filter((user) => user.status === "启用").length);
    expect(options[0]).toMatchObject({
      value: "superadmin",
      label: "超级管理员 · 系统内置 · 全部权限",
    });
    expect(options.map((option) => option.value)).toEqual(expect.arrayContaining([
      "chenchen",
      "liufang",
      "sunyue",
      "USR-0012",
    ]));
    expect(options.map((option) => option.value)).not.toContain("USR-0011");
    expect(options.find((option) => option.value === "chenchen")?.searchText)
      .toContain("chenchen 陈晨 研发审核员");
  });
});
