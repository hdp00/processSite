import { describe, expect, it } from "vitest";
import { includeSelectedAssigneeOption, isSelectedAssigneeCandidate } from "./assigneeOptions";

describe("includeSelectedAssigneeOption", () => {
  it("keeps the server candidate label for an active selected assignee", () => {
    expect(includeSelectedAssigneeOption(
      [{ value: "user-1", label: "王敏 · 质量部" }],
      "user-1",
      "王敏",
      false,
    )).toEqual([{ value: "user-1", label: "王敏 · 质量部" }]);
  });

  it("uses the task name instead of exposing an unavailable assignee id", () => {
    expect(includeSelectedAssigneeOption([], "user-internal-id", "王敏", true)).toEqual([{
      value: "user-internal-id",
      label: "王敏（已失效，请重新选择）",
      disabled: true,
    }]);
  });

  it("validates against server candidates instead of an incomplete local directory", () => {
    expect(isSelectedAssigneeCandidate(
      "remote-user",
      [{ id: "remote-user" }],
      [],
    )).toBe(true);
    expect(isSelectedAssigneeCandidate(
      "removed-user",
      [{ id: "remote-user" }],
      ["removed-user"],
    )).toBe(false);
  });
});
