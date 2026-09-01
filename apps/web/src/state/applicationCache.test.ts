import { beforeEach, describe, expect, it } from "vitest";
import { cacheProcessDefinition, cacheProcessVersion } from "../api/entityCache";
import type { AuthSession } from "../api/contracts";
import { cloneCompleteDesignerSnapshot } from "../utils/designerStorage";
import type { ProcessDefinition, ProcessVersion } from "./useProcessDefinitionStore";
import { useProcessDefinitionStore } from "./useProcessDefinitionStore";
import { hasUserPermission } from "./permissionEngine";
import { usePrototypeStore } from "./usePrototypeStore";

const version = (id: string, label: string): ProcessVersion => ({
  id,
  version: label,
  createdAt: "2026-09-01T00:00:00Z",
  createdBy: "管理员",
  updatedAt: "2026-09-01T00:00:00Z",
  updatedBy: "管理员",
  changeNote: "测试",
  instanceCount: 0,
  formFieldCount: 1,
  nodeCount: 0,
  starterGroups: [],
  checksum: id,
  basic: {
    name: "测试流程",
    code: "PROC-TEST",
    instancePrefix: "TEST",
    type: "approval",
    description: "测试",
    starterGroups: [],
    closeGroups: [],
    visibleRoles: [],
    visibleUsers: [],
  },
  snapshot: cloneCompleteDesignerSnapshot(),
  validation: { status: "通过", checkedAt: "2026-09-01T00:00:00Z", issues: [] },
});

const definition = (): ProcessDefinition => ({
  id: "definition-1",
  code: "PROC-TEST",
  name: "测试流程",
  description: "测试",
  type: "approval",
  disabled: false,
  publishedVersionId: "version-1",
  nextVersionNumber: 2,
  versions: [version("version-1", "V1")],
  updatedAt: "2026-09-01T00:00:00Z",
  updatedBy: "管理员",
  instanceCount: 0,
});

const session: AuthSession = {
  user: {
    id: "user-1",
    account: "user1",
    email: "",
    name: "测试用户",
    authenticationMode: "password",
    department: [],
    departmentPath: "",
    jobTitle: "",
    roles: [],
    status: "启用",
    lastLogin: "刚刚",
  },
  permissions: ["work-task:查看"],
  superAdmin: false,
};

describe("server-backed application cache", () => {
  beforeEach(() => {
    usePrototypeStore.getState().logout();
    useProcessDefinitionStore.setState({ definitions: [] });
  });

  it("derives permissions only from the active server session", () => {
    usePrototypeStore.getState().applyAuthSession(session);

    expect(hasUserPermission("user-1", "work-task:查看")).toBe(true);
    expect(hasUserPermission("user-1", "work-task:审核")).toBe(false);
    expect(hasUserPermission("another-user", "work-task:查看")).toBe(false);

    usePrototypeStore.getState().logout();
    expect(hasUserPermission("user-1", "work-task:查看")).toBe(false);
  });

  it("replaces cached REST entities without producing a second business state", () => {
    cacheProcessDefinition(definition());
    cacheProcessDefinition({ ...definition(), name: "服务端新名称" });
    cacheProcessVersion("definition-1", version("version-2", "V2"));

    const cached = useProcessDefinitionStore.getState().definitions;
    expect(cached).toHaveLength(1);
    expect(cached[0].name).toBe("服务端新名称");
    expect(cached[0].versions.map((item) => item.id)).toEqual(["version-2", "version-1"]);
  });
});
