import { describe, expect, it } from "vitest";
import type { ProcessInstance } from "../data/types";
import { canEditProcessInstanceSubmission, isProcessInstanceCreator, isProcessInstanceResubmissionTodo } from "./processInstanceAccess";

const instance = {
  initiatorId: "user-a",
  initiator: "同名用户",
} as ProcessInstance;

describe("isProcessInstanceCreator", () => {
  it("uses the stable initiator id when it is available", () => {
    expect(isProcessInstanceCreator(instance, { id: "user-a", name: "任意姓名" })).toBe(true);
    expect(isProcessInstanceCreator(instance, { id: "user-b", name: "同名用户" })).toBe(false);
  });

  it("falls back to the initiator name for legacy instances", () => {
    const legacyInstance = { ...instance, initiatorId: "" };
    expect(isProcessInstanceCreator(legacyInstance, { id: "user-a", name: "同名用户" })).toBe(true);
  });

  it("does not inherit edit access from unrelated permissions but allows a system override", () => {
    const otherUser = { id: "user-b", name: "其他成员" };
    expect(canEditProcessInstanceSubmission(instance, otherUser)).toBe(false);
    expect(canEditProcessInstanceSubmission(instance, otherUser, true)).toBe(true);
  });

  it("returns rejected approval instances to the creator as resubmission todos", () => {
    const rejected = { ...instance, workflowType: "approval", status: "驳回待处理" } as ProcessInstance;
    expect(isProcessInstanceResubmissionTodo(rejected, { id: "user-a", name: "任意姓名" })).toBe(true);
    expect(isProcessInstanceResubmissionTodo(rejected, { id: "user-b", name: "同名用户" })).toBe(false);
    expect(isProcessInstanceResubmissionTodo({ ...rejected, status: "审核中" }, { id: "user-a", name: "任意姓名" })).toBe(false);
  });
});
