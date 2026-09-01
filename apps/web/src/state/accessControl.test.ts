// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessInstance, WorkflowTask } from "../data/types";
import type { ProcessDefinition } from "./useProcessDefinitionStore";
import {
  currentSessionUserId,
  currentUserCan,
  hasUserPermission,
  normalizeRolePermissionList,
  ROLE_PERMISSIONS_CHANGED_EVENT,
} from "./permissionEngine";
import {
  canPersonaAccessLaunch,
  canPersonaLaunchDefinition,
  notifyRolePermissionsChanged,
} from "./rolePermissions";
import { useProcessDefinitionStore } from "./useProcessDefinitionStore";
import { usePrototypeStore } from "./usePrototypeStore";
import {
  canUserCloseInstance,
  canUserProcessTask,
  canUserViewDefinition,
  canUserViewInstance,
} from "./workflowAccess";

const instance = {
  id: "instance-1",
  canClose: true,
} as ProcessInstance;

const definition = {
  id: "definition-1",
  disabled: false,
  publishedVersionId: "version-1",
  versions: [{ id: "version-1" }],
} as ProcessDefinition;

const task = (allowedActions: WorkflowTask["allowedActions"]): WorkflowTask => ({
  id: "task-1",
  instanceId: instance.id,
  definitionId: definition.id,
  versionId: "version-1",
  nodeId: "node-1",
  nodeName: "审核",
  permissionGroupId: "group-1",
  allowedActions,
  status: "待处理",
  createdAt: "2026-09-01T00:00:00Z",
  round: 1,
});

beforeEach(() => {
  usePrototypeStore.getState().logout();
  useProcessDefinitionStore.setState({ definitions: [definition] });
});

describe("后端会话权限", () => {
  it("归一化历史动作并删除未知和重复权限", () => {
    expect(normalizeRolePermissionList([
      "org-user:新增",
      "org-user:编辑",
      "work-task:驳回",
      "work-task:审核",
      "unknown",
    ])).toEqual(["org-user:编辑", "work-task:审核"]);
  });

  it("只信任当前已认证会话返回的权限", () => {
    usePrototypeStore.setState({
      authenticated: true,
      personaId: "user-1",
      sessionPermissions: ["work-list:查看"],
      sessionSuperAdmin: false,
    });
    expect(hasUserPermission("user-1", "work-list:查看")).toBe(true);
    expect(hasUserPermission("other", "work-list:查看")).toBe(false);
    expect(currentSessionUserId()).toBe("user-1");
    expect(currentUserCan("work-task:审核")).toBe(false);

    usePrototypeStore.setState({ sessionSuperAdmin: true });
    expect(hasUserPermission("user-1", "anything")).toBe(true);
  });

  it("发起入口使用会话权限，候选定义必须来自后端缓存且已发布", () => {
    usePrototypeStore.setState({
      authenticated: true,
      personaId: "user-1",
      sessionPermissions: ["work-launch:查看", "work-launch:发起"],
      sessionSuperAdmin: false,
    });
    expect(canPersonaAccessLaunch("user-1")).toBe(true);
    expect(canPersonaLaunchDefinition("user-1", definition.id)).toBe(true);
    expect(canPersonaLaunchDefinition("user-1", "missing")).toBe(false);
    useProcessDefinitionStore.setState({ definitions: [{ ...definition, disabled: true }] });
    expect(canPersonaLaunchDefinition("user-1", definition.id)).toBe(false);

    const listener = vi.fn();
    window.addEventListener(ROLE_PERMISSIONS_CHANGED_EVENT, listener);
    notifyRolePermissionsChanged();
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(ROLE_PERMISSIONS_CHANGED_EVENT, listener);
  });
});

describe("后端返回能力控制界面入口", () => {
  beforeEach(() => {
    usePrototypeStore.setState({
      authenticated: true,
      personaId: "user-1",
      sessionPermissions: ["work-list:查看", "work-task:审核", "work-task:关闭"],
      sessionSuperAdmin: false,
    });
  });

  it("只对后端已返回的实例和定义开放查看入口", () => {
    expect(canUserViewInstance("user-1", instance)).toBe(true);
    expect(canUserViewDefinition("user-1", definition.id)).toBe(true);
    expect(canUserViewDefinition("user-1", "missing")).toBe(false);
    expect(canUserViewInstance("other", instance)).toBe(false);
  });

  it("任务按钮读取后端 allowedActions，关闭按钮读取后端 canClose", () => {
    expect(canUserProcessTask("user-1", task(["pass"]))).toBe(true);
    expect(canUserProcessTask("user-1", task(["reply"]))).toBe(false);
    expect(canUserProcessTask("user-1", task(undefined))).toBe(false);
    expect(canUserCloseInstance("user-1", instance)).toBe(true);
    expect(canUserCloseInstance("user-1", { ...instance, canClose: false })).toBe(false);
  });
});
