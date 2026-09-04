import { describe, expect, it } from "vitest";
import type { DirectoryUser } from "../api/contracts";
import { directoryUserDisplay } from "./processDefinitionUserReferences";

const user: DirectoryUser = {
  id: "user-1",
  account: "wangmin",
  email: "wangmin@example.test",
  name: "王敏",
  authenticationMode: "domain",
  department: [],
  departmentPath: "质量部",
  jobTitle: "工程师",
  roles: [],
  status: "启用",
  lastLogin: "",
};

describe("directoryUserDisplay", () => {
  it("renders a loaded user name and email", () => {
    expect(directoryUserDisplay([user], user.id, true)).toBe("王敏 <wangmin@example.test>");
  });

  it("does not expose an unresolved internal user id", () => {
    expect(directoryUserDisplay([], "internal-user-id", true)).toBe("已删除用户");
  });
});
