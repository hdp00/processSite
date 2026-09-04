import { describe, expect, it } from "vitest";
import { processDefinitionImportReferencedUserNames } from "./processDefinitionTransfer";

describe("processDefinitionImportReferencedUserNames", () => {
  it("collects unique user names from visibility and email notification references", () => {
    expect(processDefinitionImportReferencedUserNames({
      流程定义: {
        版本: [{
          基本信息: { 额外可见用户: ["王敏", "李文"] },
          流程设计: { 节点: [{ 邮件通知: { 额外通知用户: ["李文", "张华"] } }] },
        }],
      },
    })).toEqual(["王敏", "李文", "张华"]);
  });
});
