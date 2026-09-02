import { afterEach, describe, expect, it, vi } from "vitest";
import { flowPilotApi } from "../api/flowPilotApi";
import type { ProcessDefinition, ProcessVersion } from "../state/useProcessDefinitionStore";
import { createNextProcessVersion } from "./processVersionActions";

afterEach(() => vi.restoreAllMocks());

describe("复制新建下一版本", () => {
  it("先读取流程定义强 ETag，并原样用于创建请求", async () => {
    const created = { id: "version-2" } as ProcessVersion;
    vi.spyOn(flowPilotApi.definitions, "getResource").mockResolvedValue({
      data: { id: "definition-1" } as ProcessDefinition,
      etag: "\"7\"",
      requestId: "request-1",
    });
    const createVersion = vi.spyOn(flowPilotApi.definitions, "createVersion").mockResolvedValue(created);

    await expect(createNextProcessVersion("definition-1", "version-1")).resolves.toBe(created);
    expect(createVersion).toHaveBeenCalledWith("definition-1", "version-1", "\"7\"");
  });

  it("未获得 ETag 时停止创建，不发送无并发保护的写请求", async () => {
    vi.spyOn(flowPilotApi.definitions, "getResource").mockResolvedValue({
      data: { id: "definition-1" } as ProcessDefinition,
      requestId: "request-1",
    });
    const createVersion = vi.spyOn(flowPilotApi.definitions, "createVersion");

    await expect(createNextProcessVersion("definition-1", "version-1"))
      .rejects.toThrow("未获得流程定义的并发版本");
    expect(createVersion).not.toHaveBeenCalled();
  });
});
