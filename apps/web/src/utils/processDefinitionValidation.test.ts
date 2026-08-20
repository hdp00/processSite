import { describe, expect, it } from "vitest";
import type { WorkflowPermissionGroup } from "../state/useIdentityStore";
import { createProcessTitleField, type CompleteDesignerSnapshot } from "./designerStorage";
import { validateApprovalFlow, validateProcessSnapshot } from "./processDefinitionValidation";

const node = (id: string, kind: "start" | "approval" | "end", editableFields: string[] = []) => ({
  id,
  data: {
    kind,
    label: id,
    permissionGroups: kind === "start" ? ["starter"] : undefined,
    permissionGroup: kind === "approval" ? "reviewer" : undefined,
    editableFields,
  },
});

const group = (
  id: string,
  purposes: WorkflowPermissionGroup["purposes"],
  status: WorkflowPermissionGroup["status"] = "启用",
): WorkflowPermissionGroup => ({
  id,
  code: id,
  name: id,
  processes: [],
  purposes,
  directMembers: [],
  linkedRoles: [],
  status,
  referenced: false,
  openTasks: 0,
  updatedAt: "2026-08-20 10:00",
});

describe("统一流程版本校验", () => {
  it("blocks cycles and disconnected approval nodes", () => {
    const nodes = [node("start", "start"), node("review", "approval"), node("end", "end")];
    const checks = validateApprovalFlow(
      nodes,
      [
        { source: "start", target: "review" },
        { source: "review", target: "review" },
        { source: "review", target: "end" },
      ],
      [createProcessTitleField()],
    );

    expect(checks.find((check) => check.key === "connected")?.pass).toBe(false);
  });

  it("blocks two parallel branches editing the same field", () => {
    const editable = { ...createProcessTitleField(), id: "result", label: "处理结果", inputStage: "both" as const };
    const nodes = [
      node("start", "start"),
      node("review-a", "approval", ["result"]),
      node("review-b", "approval", ["result"]),
      node("end", "end"),
    ];
    const checks = validateApprovalFlow(
      nodes,
      [
        { source: "start", target: "review-a" },
        { source: "start", target: "review-b" },
        { source: "review-a", target: "end" },
        { source: "review-b", target: "end" },
      ],
      [createProcessTitleField(), editable],
    );

    expect(checks.find((check) => check.key === "field-conflict")?.detail).toContain("处理结果");
    expect(checks.find((check) => check.key === "field-conflict")?.pass).toBe(false);
  });

  it("blocks publishing with a stopped or empty workflow permission group", () => {
    const snapshot: CompleteDesignerSnapshot = {
      form: { fields: [createProcessTitleField()] },
      flow: {
        nodes: [node("start", "start"), node("review", "approval"), node("end", "end")],
        edges: [
          { source: "start", target: "review" },
          { source: "review", target: "end" },
        ],
      },
      systemFields: [],
    };
    const result = validateProcessSnapshot(
      {
        name: "测试流程",
        instancePrefix: "TEST_",
        type: "approval",
        starterGroups: ["starter"],
        closeGroups: ["closer"],
      },
      snapshot,
      {
        workflowGroups: [
          group("starter", ["发起"]),
          group("closer", ["关闭"]),
          group("reviewer", ["审批/受理"], "停用"),
        ],
        effectiveMemberIds: (id) => id === "closer" ? [] : ["user-1"],
      },
    );

    expect(result.status).toBe("未通过");
    expect(result.issues.join("；")).toContain("没有有效成员");
    expect(result.issues.join("；")).toContain("已停用");
  });
});
