import { describe, expect, it } from "vitest";
import type { ProcessDefinition, ProcessVersion } from "./useProcessDefinitionStore";
import { resolveLockedProcessVersion } from "./processVersionResolver";

const version = (id: string, label: string) => ({ id, version: label }) as ProcessVersion;

const definition = (publishedVersionId?: string): ProcessDefinition => ({
  id: "definition-a",
  code: "FLOW-A",
  name: "流程 A",
  description: "",
  type: "approval",
  disabled: false,
  publishedVersionId,
  nextVersionNumber: 3,
  versions: [version("version-1", "V1"), version("version-2", "V2")],
  updatedAt: "2026-08-19 10:00:00",
  updatedBy: "测试用户",
  instanceCount: 1,
});

describe("resolveLockedProcessVersion", () => {
  it("始终解析实例锁定版本，不受当前发布版本切换影响", () => {
    const current = definition("version-2");
    expect(resolveLockedProcessVersion(current, { versionId: "version-1", templateVersion: "V1" })?.id)
      .toBe("version-1");
  });

  it("锁定版本缺失时不回退到当前发布版本", () => {
    const current = definition("version-2");
    expect(resolveLockedProcessVersion(current, { versionId: "deleted-version", templateVersion: "V1" }))
      .toBeUndefined();
  });

  it("仅为没有 versionId 的旧数据按版本文本迁移", () => {
    const current = definition();
    expect(resolveLockedProcessVersion(current, { templateVersion: "1" })?.id).toBe("version-1");
    expect(resolveLockedProcessVersion(current, { templateVersion: "  v2  " })?.id).toBe("version-2");
  });

  it("定义不存在或旧版本文本为空时不猜测当前发布版本", () => {
    expect(resolveLockedProcessVersion(undefined, { templateVersion: "V1" })).toBeUndefined();
    expect(resolveLockedProcessVersion(definition("version-2"), { templateVersion: "   " })).toBeUndefined();
  });

  it("同时归一化实例与历史定义中的无前缀版本号", () => {
    const current = definition();
    current.versions[1] = version("version-2", "2");
    expect(resolveLockedProcessVersion(current, { templateVersion: "V2" })?.id).toBe("version-2");
  });
});
