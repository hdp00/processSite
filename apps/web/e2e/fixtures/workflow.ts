import { randomUUID } from "node:crypto";
import type { APIResponse, Page } from "@playwright/test";

interface CreatedUser {
  id: string;
  name: string;
  loginName: string;
  password: string;
}

interface WorkflowFixtureOptions {
  userPermissions?: string[];
}

interface FlowNode {
  id: string;
  position: { x: number; y: number };
  data: {
    kind: "start" | "approval" | "end";
    label: string;
    [key: string]: unknown;
  };
}

interface CreatedDefinitionResponse {
  definition: { id: string };
  version: {
    id: string;
    snapshot: {
      systemFields: unknown[];
      flow: {
        nodes: FlowNode[];
        edges: unknown[];
        meta: Record<string, unknown>;
      };
    };
  };
}

export interface PublishedWorkflow {
  definitionId: string;
  versionId: string;
  name: string;
  primaryUser: CreatedUser;
  secondaryUser: CreatedUser;
  approvalNodeId?: string;
}

async function requireSuccess(response: APIResponse, operation: string) {
  if (response.ok()) return response;
  throw new Error(`${operation}失败（HTTP ${response.status()}）：${await response.text()}`);
}

function mutationHeaders(origin: string, idempotencyKey?: string) {
  return {
    Origin: origin,
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
}

function requireEtag(response: APIResponse, operation: string) {
  const etag = response.headers().etag;
  if (!etag) throw new Error(`${operation}响应缺少 ETag。`);
  return etag;
}

export async function createPublishedWorkflow(
  page: Page,
  type: "approval" | "free",
  options: WorkflowFixtureOptions = {},
): Promise<PublishedWorkflow> {
  const origin = new URL(page.url()).origin;
  const runId = randomUUID().replaceAll("-", "");
  const shortId = runId.slice(0, 8);
  const name = `${type === "approval" ? "审批" : "协作"}浏览器链路-${shortId}`;
  const roleIds: string[] = [];

  if (options.userPermissions?.length) {
    const roleResponse = await page.request.post("/api/flowpilot/v1/roles", {
      headers: mutationHeaders(origin, `e2e-role-${runId}`),
      data: {
        name: `浏览器链路角色-${shortId}`,
        description: "隔离 Playwright 普通用户权限链路",
        status: "enabled",
        memberIds: [],
      },
    });
    await requireSuccess(roleResponse, "创建浏览器测试角色");
    const role = await roleResponse.json() as { id: string };
    const permissionResponse = await page.request.put(
      `/api/flowpilot/v1/roles/${role.id}/permissions`,
      {
        headers: {
          ...mutationHeaders(origin),
          "If-Match": requireEtag(roleResponse, "创建浏览器测试角色"),
        },
        data: { permissionCodes: options.userPermissions },
      },
    );
    await requireSuccess(permissionResponse, "配置浏览器测试角色权限");
    roleIds.push(role.id);
  }

  const createUser = async (label: string): Promise<CreatedUser> => {
    const loginName = `e2e-${label}-${runId}`;
    const password = `E2E-${runId}!`;
    const response = await page.request.post("/api/flowpilot/v1/users", {
      headers: mutationHeaders(origin, `e2e-user-${label}-${runId}`),
      data: {
        loginName,
        name: `${label === "primary" ? "测试受理人甲" : "测试受理人乙"}-${shortId}`,
        email: "",
        departmentId: null,
        positionId: null,
        roleIds,
        authenticationMode: "password",
        initialPassword: password,
        status: "enabled",
      },
    });
    await requireSuccess(response, "创建浏览器测试用户");
    const user = await response.json() as Pick<CreatedUser, "id" | "name">;
    return { ...user, loginName, password };
  };

  const primaryUser = await createUser("primary");
  const secondaryUser = await createUser("secondary");
  const groupResponse = await page.request.post(
    "/api/flowpilot/v1/workflow-permission-groups",
    {
      headers: mutationHeaders(origin, `e2e-group-${runId}`),
      data: {
        name: `浏览器链路权限组-${shortId}`,
        description: "隔离 Playwright 流程写链路",
        purposes: ["start", "review-or-accept", "close"],
        status: "enabled",
        directUserIds: [primaryUser.id, secondaryUser.id],
        roleIds: [],
      },
    },
  );
  await requireSuccess(groupResponse, "创建浏览器测试流程权限组");
  const group = await groupResponse.json() as { id: string };

  const basic = {
    name,
    instancePrefix: `${type === "approval" ? "EA" : "EF"}${shortId}`,
    type,
    description: "Playwright 隔离数据库完整写链路",
    starterGroupIds: [group.id],
    ...(type === "free" ? { assigneeGroupIds: [group.id] } : {}),
    closeGroupIds: [group.id],
    visibleRoleIds: [],
    visibleUserIds: [],
  };
  const createDefinitionResponse = await page.request.post(
    "/api/flowpilot/v1/process-definitions",
    {
      headers: mutationHeaders(origin, `e2e-definition-${runId}`),
      data: { basic },
    },
  );
  await requireSuccess(createDefinitionResponse, "创建浏览器测试流程定义");
  const created = await createDefinitionResponse.json() as CreatedDefinitionResponse;
  let etag = requireEtag(createDefinitionResponse, "创建流程定义");

  const fields = [
    {
      id: "title",
      type: "text",
      label: "标题",
      required: true,
      listVisible: true,
      taskVisible: true,
      queryable: true,
      exportVisible: true,
      inputStage: "initiator",
    },
    ...(type === "approval" ? [{
      id: "review-note",
      type: "text",
      label: "审核补充",
      required: false,
      listVisible: false,
      taskVisible: true,
      queryable: false,
      exportVisible: true,
      inputStage: "reviewer",
    }] : []),
  ];
  const saveFormResponse = await page.request.put(
    `/api/flowpilot/v1/process-definitions/${created.definition.id}/versions/${created.version.id}/form-designer`,
    {
      headers: { ...mutationHeaders(origin), "If-Match": etag },
      data: {
        form: { fields },
        systemFields: created.version.snapshot.systemFields,
      },
    },
  );
  await requireSuccess(saveFormResponse, "保存浏览器测试初始表单");
  etag = requireEtag(saveFormResponse, "保存初始表单");

  let approvalNodeId: string | undefined;
  if (type === "approval") {
    const flow = structuredClone(created.version.snapshot.flow);
    const approvalNode = flow.nodes.find((node) => node.data.kind === "approval");
    if (!approvalNode) throw new Error("新建审批流程没有默认审批节点。");
    approvalNodeId = approvalNode.id;
    approvalNode.data = {
      ...approvalNode.data,
      permissionGroupId: group.id,
      specifyAssignee: true,
      editableFieldIds: ["review-note"],
      handlingMode: "approval",
      allowRepeatedEditing: false,
    };
    flow.meta.rejectionHandling = "resubmit-only";

    const saveFlowResponse = await page.request.put(
      `/api/flowpilot/v1/process-definitions/${created.definition.id}/versions/${created.version.id}/flow-designer`,
      {
        headers: { ...mutationHeaders(origin), "If-Match": etag },
        data: {
          basicPatch: { name, starterGroupIds: [group.id] },
          flow,
        },
      },
    );
    await requireSuccess(saveFlowResponse, "保存浏览器测试审批流程图");
    etag = requireEtag(saveFlowResponse, "保存审批流程图");
  }

  const validationResponse = await page.request.post(
    `/api/flowpilot/v1/process-definitions/${created.definition.id}/versions/${created.version.id}/validate`,
    {
      headers: {
        ...mutationHeaders(origin, `e2e-validate-${runId}`),
        "If-Match": etag,
      },
    },
  );
  await requireSuccess(validationResponse, "校验浏览器测试流程定义");
  const validation = await validationResponse.json() as { status: string; issues: unknown[] };
  if (validation.status !== "passed") {
    throw new Error(`浏览器测试流程定义校验未通过：${JSON.stringify(validation.issues)}`);
  }
  etag = requireEtag(validationResponse, "校验流程定义");

  const publishResponse = await page.request.post(
    `/api/flowpilot/v1/process-definitions/${created.definition.id}/versions/${created.version.id}/publish`,
    {
      headers: {
        ...mutationHeaders(origin, `e2e-publish-${runId}`),
        "If-Match": etag,
      },
      data: { changeNote: "Playwright 隔离数据库链路发布" },
    },
  );
  await requireSuccess(publishResponse, "发布浏览器测试流程定义");

  return {
    definitionId: created.definition.id,
    versionId: created.version.id,
    name,
    primaryUser,
    secondaryUser,
    approvalNodeId,
  };
}

export async function unpublishWorkflow(page: Page, workflow: PublishedWorkflow) {
  const origin = new URL(page.url()).origin;
  const definitionResponse = await page.request.get(
    `/api/flowpilot/v1/process-definitions/${workflow.definitionId}`,
  );
  await requireSuccess(definitionResponse, "读取待取消发布的流程定义");
  const etag = requireEtag(definitionResponse, "读取流程定义");
  const response = await page.request.post(
    `/api/flowpilot/v1/process-definitions/${workflow.definitionId}/versions/${workflow.versionId}/unpublish`,
    {
      headers: {
        ...mutationHeaders(origin, `e2e-unpublish-${randomUUID()}`),
        "If-Match": etag,
      },
      data: { reason: "切换为可编辑状态以验证设计器重新进入" },
    },
  );
  await requireSuccess(response, "取消发布浏览器测试流程定义");
}
