import { describe, expect, it } from "vitest";
import type { ProcessInstance } from "../data/types";
import { canEditProcessInstanceSubmission, isProcessInstanceCreator } from "./processInstanceAccess";

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
    const legacyInstance = { ...instance, initiatorId: undefined };
    expect(isProcessInstanceCreator(legacyInstance, { id: "user-a", name: "同名用户" })).toBe(true);
  });

  it("does not inherit edit access from unrelated permissions but allows a system override", () => {
    const otherUser = { id: "user-b", name: "其他成员" };
    expect(canEditProcessInstanceSubmission(instance, otherUser)).toBe(false);
    expect(canEditProcessInstanceSubmission(instance, otherUser, true)).toBe(true);
  });
});
