import { flowPilotApi } from "../api/flowPilotApi";

export async function createNextProcessVersion(definitionId: string, sourceVersionId: string) {
  const definition = await flowPilotApi.definitions.getResource(definitionId);
  if (!definition.etag) {
    throw new Error("未获得流程定义的并发版本，请刷新页面后重试");
  }
  return flowPilotApi.definitions.createVersion(definitionId, sourceVersionId, definition.etag);
}
