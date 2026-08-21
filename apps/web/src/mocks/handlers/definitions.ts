import { http } from "msw";
import type { DirectoryUser, ProcessDefinitionListItem } from "../../api/contracts";
import type { DomainUser } from "../../state/useIdentityStore";
import {
  effectiveGroupMemberIds,
  findIdentityUser,
  useIdentityStore,
} from "../../state/useIdentityStore";
import type {
  DefinitionType,
  ProcessBasicConfig,
  ProcessDefinition,
  ProcessVersion,
} from "../../state/useProcessDefinitionStore";
import {
  canEditVersion,
  definitionStatus,
  useProcessDefinitionStore,
} from "../../state/useProcessDefinitionStore";
import { canPersonaLaunchDefinition } from "../../state/rolePermissions";
import { hasUserPermission } from "../../state/permissionEngine";
import { usePrototypeStore } from "../../state/usePrototypeStore";
import { canUserViewDefinition, canUserViewInstance } from "../../state/workflowAccess";
import { compareDomainTimestamps } from "../../utils/domainTime";
import type { CompleteDesignerSnapshot } from "../../utils/designerStorage";
import { parseProcessDefinitionImport } from "../../utils/processDefinitionTransfer";
import { MOCK_API_BASE_URL } from "../apiBase";
import {
  apiNoContent,
  apiOk,
  apiProblem,
  appendAuditEvent,
  applyMockScenario,
  checkIfMatch,
  entityEtag,
  pageQuery,
  paginate,
  parseJsonBody,
  requireActor,
  requirePermission,
  withIdempotency,
} from "../runtime";

const API = MOCK_API_BASE_URL;

const definitionById = (definitionId: string) =>
  useProcessDefinitionStore.getState().definitions.find((item) => item.id === definitionId);

const versionById = (definitionId: string, versionId: string) =>
  definitionById(definitionId)?.versions.find((item) => item.id === versionId);

const routeIds = (params: Record<string, string | readonly string[] | undefined>) => ({
  definitionId: String(params.definitionId ?? ""),
  versionId: String(params.versionId ?? ""),
});

const withEtag = (entity: unknown) => ({ ETag: entityEtag(entity) });

const publicUser = (user: DomainUser): DirectoryUser => ({
  id: user.id,
  account: user.account,
  email: user.email,
  name: user.name,
  authenticationMode: user.authenticationMode,
  department: [...user.department],
  departmentPath: user.departmentPath,
  jobTitle: user.jobTitle,
  roles: [...user.roles],
  status: user.status,
  lastLogin: user.lastLogin,
  builtIn: user.builtIn,
});

const requireDefinition = (request: Request, definitionId: string) => {
  const definition = definitionById(definitionId);
  return definition
    ? { definition }
    : { response: apiProblem(request, 404, "DEFINITION_NOT_FOUND", "流程定义不存在", "未找到指定的流程定义。") };
};

const requireVersion = (request: Request, definitionId: string, versionId: string) => {
  const definition = definitionById(definitionId);
  const version = definition?.versions.find((item) => item.id === versionId);
  return definition && version
    ? { definition, version }
    : { response: apiProblem(request, 404, "VERSION_NOT_FOUND", "流程版本不存在", "未找到指定的流程版本。") };
};

const definitionListItem = (definition: ProcessDefinition): ProcessDefinitionListItem => ({
  ...structuredClone(definition),
  status: definitionStatus(definition) === "已停用"
    ? "disabled"
    : definitionStatus(definition) === "已发布" ? "published" : "unpublished",
});

const auditDefinition = (actorId: string, actorName: string, action: string, definition: ProcessDefinition, summary: string) =>
  appendAuditEvent({
    category: "definition",
    action,
    actorId,
    actorName,
    resourceType: "process-definition",
    resourceId: definition.id,
    summary,
  });

export const definitionHandlers = [
  http.get(`${API}/me/launchable-process-definitions`, async ({ request }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "work-launch:查看");
    if (auth.response) return auth.response;
    const items = useProcessDefinitionStore.getState().definitions
      .filter((definition) => Boolean(definition.publishedVersionId) && !definition.disabled)
      .filter((definition) => canPersonaLaunchDefinition(auth.actor.id, definition.id))
      .flatMap((definition) => {
        const version = definition.versions.find((item) => item.id === definition.publishedVersionId);
        return version ? [{
          definitionId: definition.id,
          code: definition.code,
          name: definition.name,
          type: definition.type,
          versionId: version.id,
          versionLabel: version.version,
          description: definition.description,
          starterGroups: [...version.basic.starterGroups],
        }] : [];
      });
    return apiOk(request, items);
  }),

  http.get(`${API}/me/visible-process-definitions`, async ({ request }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requireActor(request);
    if (auth.response) return auth.response;
    if (!hasUserPermission(auth.actor.id, "work-list:查看") && !hasUserPermission(auth.actor.id, "work-launch:查看")) {
      return apiProblem(request, 403, "PERMISSION_DENIED", "没有操作权限", "当前账号没有流程清单或流程发起查看权限。 ");
    }
    const pagination = pageQuery(request);
    if ("response" in pagination) return pagination.response;
    const visibleInstances = usePrototypeStore.getState().instances.filter((instance) => canUserViewInstance(auth.actor.id, instance));
    const visibleVersionIds = new Set(visibleInstances.map((instance) => instance.versionId).filter(Boolean));
    const items = useProcessDefinitionStore.getState().definitions
      .filter((definition) => canUserViewDefinition(auth.actor.id, definition.id) || visibleInstances.some((instance) => instance.definitionId === definition.id))
      .map((definition) => ({
        ...definition,
        versions: definition.versions.filter((version) =>
          version.id === definition.publishedVersionId || visibleVersionIds.has(version.id)),
      }))
      .map(definitionListItem)
      .sort((left, right) => compareDomainTimestamps(right.updatedAt, left.updatedAt));
    return apiOk(request, paginate(items, pagination.number, pagination.size));
  }),

  http.get(`${API}/process-definitions`, async ({ request }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "config-definition:查看");
    if (auth.response) return auth.response;
    const pagination = pageQuery(request);
    if ("response" in pagination) return pagination.response;
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const type = url.searchParams.get("type") as DefinitionType | null;
    const status = url.searchParams.get("status");
    const items = useProcessDefinitionStore.getState().definitions
      .map(definitionListItem)
      .filter((item) => !q || `${item.code}${item.name}${item.description}`.toLowerCase().includes(q))
      .filter((item) => !type || item.type === type)
      .filter((item) => !status || item.status === status)
      .sort((left, right) => compareDomainTimestamps(right.updatedAt, left.updatedAt));
    return apiOk(request, paginate(items, pagination.number, pagination.size));
  }),

  http.post(`${API}/process-definitions`, async ({ request }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "config-definition:编辑");
      if (auth.response) return auth.response;
      const body = await parseJsonBody<{ basic?: ProcessBasicConfig }>(request);
      if (body instanceof Response) return body;
      const name = body.basic?.name?.trim() ?? "";
      if (!name || !["approval", "free"].includes(body.basic?.type ?? "")) {
        return apiProblem(request, 422, "VALIDATION_FAILED", "流程定义校验失败", "请填写流程名称并选择有效的流程类型。", {
          errors: [
            ...(!name ? [{ path: "name", code: "REQUIRED", message: "流程名称不能为空" }] : []),
            ...(!["approval", "free"].includes(body.basic?.type ?? "") ? [{ path: "basic.type", code: "INVALID_ENUM", message: "流程类型无效" }] : []),
          ],
        });
      }
      const duplicated = useProcessDefinitionStore.getState().definitions.some((item) => item.name.trim().toLowerCase() === name.toLowerCase());
      if (duplicated) return apiProblem(request, 409, "DEFINITION_NAME_CONFLICT", "流程名称已存在", "请使用其他流程名称。 ");
      const definitionId = useProcessDefinitionStore.getState().createDefinition({ name, type: body.basic!.type, description: body.basic!.description });
      const created = definitionById(definitionId);
      const createdVersion = created?.versions[0];
      if (created && createdVersion) {
        useProcessDefinitionStore.getState().updateVersionBasic(definitionId, createdVersion.id, {
          ...body.basic!,
          name,
          code: createdVersion.basic.code,
        });
      }
      const definition = definitionById(definitionId);
      const version = definition?.versions[0];
      if (!definition || !version) return apiProblem(request, 403, "DEFINITION_CREATE_FORBIDDEN", "无法创建流程定义", "当前用户没有创建流程定义的权限。 ");
      auditDefinition(auth.actor.id, auth.actor.name, "create", definition, `创建流程定义 ${definition.name}`);
      return apiOk(request, { definition, version }, { status: 201, headers: { Location: `${API}/process-definitions/${definition.id}`, ...withEtag(definition) } });
    });
  }),

  http.post(`${API}/process-definitions/imports`, async ({ request }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "config-definition:编辑");
      if (auth.response) return auth.response;
      const body = await parseJsonBody<{ document?: unknown }>(request);
      if (body instanceof Response) return body;
      if (!body.document) return apiProblem(request, 422, "IMPORT_DOCUMENT_REQUIRED", "导入文件不能为空", "请提交完整的流程定义导出文档。 ");
      try {
        const identities = useIdentityStore.getState();
        const preview = parseProcessDefinitionImport(JSON.stringify(body.document), identities);
        const importedId = useProcessDefinitionStore.getState().importDefinition(preview.definition);
        if (!importedId) return apiProblem(request, 409, "DEFINITION_IMPORT_FAILED", "流程定义导入失败", "导入事务未能生成有效的流程定义。 ");
        const imported = definitionById(importedId);
        if (!imported) return apiProblem(request, 409, "DEFINITION_IMPORT_FAILED", "流程定义导入失败", "导入事务未能创建完整流程定义。 ");
        auditDefinition(auth.actor.id, auth.actor.name, "import", imported, `导入流程定义 ${imported.name}`);
        return apiOk(request, structuredClone(imported), {
          status: 201,
          headers: { Location: `${API}/process-definitions/${imported.id}`, ...withEtag(imported) },
        });
      } catch (error) {
        return apiProblem(request, 422, "DEFINITION_IMPORT_INVALID", "流程定义导入文件无效", error instanceof Error ? error.message : "无法解析流程定义导入文件。 ");
      }
    });
  }),

  http.get(`${API}/process-definitions/:definitionId`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "config-definition:查看");
    if (auth.response) return auth.response;
    const { definitionId } = routeIds(params);
    const found = requireDefinition(request, definitionId);
    if ("response" in found) return found.response;
    return apiOk(request, structuredClone(found.definition), { headers: withEtag(found.definition) });
  }),

  http.patch(`${API}/process-definitions/:definitionId`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    const auth = requirePermission(request, "config-definition:编辑");
    if (auth.response) return auth.response;
    const { definitionId } = routeIds(params);
    const found = requireDefinition(request, definitionId);
    if ("response" in found) return found.response;
    const conflict = checkIfMatch(request, found.definition, true);
    if (conflict) return conflict;
    const body = await parseJsonBody<{ disabled?: boolean }>(request);
    if (body instanceof Response) return body;
    if (typeof body.disabled !== "boolean") return apiProblem(request, 422, "VALIDATION_FAILED", "可用状态无效", "disabled 必须是布尔值。 ");
    if (!found.definition.publishedVersionId && body.disabled) {
      return apiProblem(request, 409, "DEFINITION_NOT_PUBLISHED", "未发布流程不能停用", "请先发布至少一个流程版本。 ");
    }
    if (found.definition.disabled !== body.disabled) useProcessDefinitionStore.getState().toggleDefinition(definitionId);
    const updated = definitionById(definitionId)!;
    auditDefinition(auth.actor.id, auth.actor.name, body.disabled ? "disable" : "enable", updated, `${body.disabled ? "停用" : "启用"}流程定义 ${updated.name}`);
    return apiOk(request, structuredClone(updated), { headers: withEtag(updated) });
  }),

  http.delete(`${API}/process-definitions/:definitionId`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    const auth = requirePermission(request, "config-definition:删除");
    if (auth.response) return auth.response;
    const { definitionId } = routeIds(params);
    const found = requireDefinition(request, definitionId);
    if ("response" in found) return found.response;
    const conflict = checkIfMatch(request, found.definition, true);
    if (conflict) return conflict;
    const snapshot = structuredClone(found.definition);
    if (!useProcessDefinitionStore.getState().deleteDefinition(definitionId)) {
      return apiProblem(request, 409, "DELETE_BLOCKED", "流程定义不能删除", "流程已发布、已有实例或版本被实例引用。 ");
    }
    auditDefinition(auth.actor.id, auth.actor.name, "delete", snapshot, `删除流程定义 ${snapshot.name}`);
    return apiNoContent(request);
  }),

  http.post(`${API}/process-definitions/:definitionId/copies`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "config-definition:编辑");
      if (auth.response) return auth.response;
      const { definitionId } = routeIds(params);
      const found = requireDefinition(request, definitionId);
      if ("response" in found) return found.response;
      const createdId = useProcessDefinitionStore.getState().copyDefinition(definitionId);
      const definition = createdId ? definitionById(createdId) : undefined;
      const version = definition?.versions[0];
      if (!definition || !version) return apiProblem(request, 409, "DEFINITION_COPY_FAILED", "复制流程失败", "源流程没有可复制的版本。 ");
      auditDefinition(auth.actor.id, auth.actor.name, "copy", definition, `从 ${found.definition.name} 复制流程定义`);
      return apiOk(request, { definition, version }, { status: 201, headers: { Location: `${API}/process-definitions/${definition.id}`, ...withEtag(definition) } });
    });
  }),

  http.get(`${API}/process-definitions/:definitionId/launch-config`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "work-launch:发起");
    if (auth.response) return auth.response;
    const { definitionId } = routeIds(params);
    const found = requireDefinition(request, definitionId);
    if ("response" in found) return found.response;
    if (!found.definition.publishedVersionId || found.definition.disabled) {
      return apiProblem(request, 409, "DEFINITION_NOT_LAUNCHABLE", "流程暂不可发起", "流程未发布或已经停用。 ");
    }
    if (!canPersonaLaunchDefinition(auth.actor.id, definitionId)) {
      return apiProblem(request, 403, "LAUNCH_FORBIDDEN", "无权发起该流程", "当前用户不属于该流程的发起权限组。 ");
    }
    const version = found.definition.versions.find((item) => item.id === found.definition.publishedVersionId);
    if (!version) return apiProblem(request, 409, "PUBLISHED_VERSION_MISSING", "发布版本不可用", "流程发布指针所引用的版本不存在。 ");
    const assigneeCandidatesByNode = Object.fromEntries(
      version.snapshot.flow.nodes
        .filter((node) => node.data?.kind === "approval" && node.data.permissionGroup)
        .map((node) => [
          node.id,
          effectiveGroupMemberIds(node.data!.permissionGroup!)
            .map(findIdentityUser)
            .filter((user): user is DomainUser => Boolean(user?.email))
            .map(publicUser),
        ]),
    );
    const firstAssigneeGroupIds = version.snapshot.flow.nodes
      .filter((node) => node.data?.kind === "approval" && node.data.permissionGroup)
      .map((node) => node.data!.permissionGroup!)
      .slice(0, 1);
    const firstAssigneeCandidates = [...new Set(firstAssigneeGroupIds.flatMap(effectiveGroupMemberIds))]
      .map(findIdentityUser)
      .filter((user): user is DomainUser => Boolean(user?.email))
      .map(publicUser);
    return apiOk(request, {
      definition: structuredClone(found.definition),
      version: structuredClone(version),
      assigneeCandidatesByNode,
      firstAssigneeCandidates,
    }, { headers: withEtag(version) });
  }),

  http.get(`${API}/process-definitions/:definitionId/versions`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "config-definition:查看");
    if (auth.response) return auth.response;
    const { definitionId } = routeIds(params);
    const found = requireDefinition(request, definitionId);
    if ("response" in found) return found.response;
    return apiOk(request, structuredClone(found.definition.versions));
  }),

  http.post(`${API}/process-definitions/:definitionId/versions`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "config-definition:编辑");
      if (auth.response) return auth.response;
      const { definitionId } = routeIds(params);
      const found = requireDefinition(request, definitionId);
      if ("response" in found) return found.response;
      const body = await parseJsonBody<{ sourceVersionId?: string }>(request);
      if (body instanceof Response) return body;
      if (!body.sourceVersionId || !found.definition.versions.some((item) => item.id === body.sourceVersionId)) {
        return apiProblem(request, 422, "SOURCE_VERSION_INVALID", "源版本无效", "请选择该流程定义下的有效源版本。 ");
      }
      const versionId = useProcessDefinitionStore.getState().createVersion(definitionId, body.sourceVersionId);
      const version = versionId ? versionById(definitionId, versionId) : undefined;
      if (!version) return apiProblem(request, 409, "VERSION_CREATE_FAILED", "创建版本失败", "流程定义状态已经变化，请刷新后重试。 ");
      auditDefinition(auth.actor.id, auth.actor.name, "create-version", definitionById(definitionId)!, `创建版本 ${version.version}`);
      return apiOk(request, structuredClone(version), { status: 201, headers: { Location: `${API}/process-definitions/${definitionId}/versions/${version.id}`, ...withEtag(version) } });
    });
  }),

  http.get(`${API}/process-definitions/:definitionId/versions/:versionId`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "config-definition:查看");
    if (auth.response) return auth.response;
    const { definitionId, versionId } = routeIds(params);
    const found = requireVersion(request, definitionId, versionId);
    if ("response" in found) return found.response;
    return apiOk(request, structuredClone(found.version), { headers: withEtag(found.version) });
  }),

  http.put(`${API}/process-definitions/:definitionId/versions/:versionId/basic`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    const auth = requirePermission(request, "config-definition:编辑");
    if (auth.response) return auth.response;
    const { definitionId, versionId } = routeIds(params);
    const found = requireVersion(request, definitionId, versionId);
    if ("response" in found) return found.response;
    const conflict = checkIfMatch(request, found.version, true);
    if (conflict) return conflict;
    if (!canEditVersion(found.definition, found.version)) return apiProblem(request, 409, "VERSION_NOT_EDITABLE", "流程版本不可编辑", "已发布或已有实例的版本不能修改。 ");
    const body = await parseJsonBody<ProcessBasicConfig>(request);
    if (body instanceof Response) return body;
    if (!body.name?.trim() || !body.instancePrefix?.trim() || !Array.isArray(body.starterGroups) || !Array.isArray(body.closeGroups)) {
      return apiProblem(request, 422, "VALIDATION_FAILED", "基本配置校验失败", "流程名称、编号前缀、发起权限组和关闭权限组必须完整。 ");
    }
    if (!useProcessDefinitionStore.getState().updateVersionBasic(definitionId, versionId, body)) {
      return apiProblem(request, 409, "VERSION_SAVE_FAILED", "保存失败", "流程版本状态已经变化。 ");
    }
    const updated = versionById(definitionId, versionId)!;
    auditDefinition(auth.actor.id, auth.actor.name, "save-basic", definitionById(definitionId)!, `保存 ${updated.version} 基本配置`);
    return apiOk(request, structuredClone(updated), { headers: withEtag(updated) });
  }),

  http.put(`${API}/process-definitions/:definitionId/versions/:versionId/designer`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    const auth = requirePermission(request, "config-form:编辑");
    if (auth.response) return auth.response;
    const { definitionId, versionId } = routeIds(params);
    const found = requireVersion(request, definitionId, versionId);
    if ("response" in found) return found.response;
    const conflict = checkIfMatch(request, found.version, true);
    if (conflict) return conflict;
    if (!canEditVersion(found.definition, found.version)) return apiProblem(request, 409, "VERSION_NOT_EDITABLE", "流程版本不可编辑", "已发布或已有实例的版本不能修改。 ");
    const body = await parseJsonBody<Partial<CompleteDesignerSnapshot> & { basic?: ProcessBasicConfig }>(request);
    if (body instanceof Response) return body;
    if (!body.basic && !body.form && !body.flow && !body.systemFields) {
      return apiProblem(request, 422, "EMPTY_DESIGNER_UPDATE", "没有可保存的设计内容", "请至少提交 basic、form、flow 或 systemFields 分区。 ");
    }
    const store = useProcessDefinitionStore.getState();
    if (body.basic && !store.updateVersionBasic(definitionId, versionId, body.basic)) {
      return apiProblem(request, 409, "VERSION_SAVE_FAILED", "保存失败", "基本配置没有保存。 ");
    }
    const currentAfterBasic = versionById(definitionId, versionId)!;
    if ((body.form || body.systemFields) && !store.updateVersionFormSnapshot(
      definitionId,
      versionId,
      body.form ?? currentAfterBasic.snapshot.form,
      body.systemFields ?? currentAfterBasic.snapshot.systemFields,
    )) return apiProblem(request, 409, "VERSION_SAVE_FAILED", "保存失败", "表单配置没有保存。 ");
    if (body.flow && !store.updateVersionFlowSnapshot(definitionId, versionId, body.flow)) {
      return apiProblem(request, 409, "VERSION_SAVE_FAILED", "保存失败", "流程图配置没有保存。 ");
    }
    const updated = versionById(definitionId, versionId)!;
    auditDefinition(auth.actor.id, auth.actor.name, "save-designer", definitionById(definitionId)!, `保存 ${updated.version} 设计器快照`);
    return apiOk(request, structuredClone(updated), { headers: withEtag(updated) });
  }),

  http.put(`${API}/process-definitions/:definitionId/versions/:versionId/form-designer`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    const auth = requirePermission(request, "config-form:编辑");
    if (auth.response) return auth.response;
    const { definitionId, versionId } = routeIds(params);
    const found = requireVersion(request, definitionId, versionId);
    if ("response" in found) return found.response;
    const conflict = checkIfMatch(request, found.version, true);
    if (conflict) return conflict;
    if (!canEditVersion(found.definition, found.version)) return apiProblem(request, 409, "VERSION_NOT_EDITABLE", "流程版本不可编辑", "已发布或已有实例的版本不能修改。 ");
    const body = await parseJsonBody<Pick<CompleteDesignerSnapshot, "form" | "systemFields">>(request);
    if (body instanceof Response) return body;
    if (!body.form || !Array.isArray(body.systemFields)) {
      return apiProblem(request, 422, "VALIDATION_FAILED", "表单设计校验失败", "form 和 systemFields 必须同时提交。 ");
    }
    if (!useProcessDefinitionStore.getState().updateVersionFormSnapshot(definitionId, versionId, body.form, body.systemFields)) {
      return apiProblem(request, 409, "VERSION_SAVE_FAILED", "保存失败", "表单配置没有保存。 ");
    }
    const updated = versionById(definitionId, versionId)!;
    auditDefinition(auth.actor.id, auth.actor.name, "save-form-designer", definitionById(definitionId)!, `保存 ${updated.version} 表单设计`);
    return apiOk(request, { version: structuredClone(updated), removedReferences: [] }, { headers: withEtag(updated) });
  }),

  http.put(`${API}/process-definitions/:definitionId/versions/:versionId/flow-designer`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    const auth = requirePermission(request, "config-form:编辑");
    if (auth.response) return auth.response;
    const { definitionId, versionId } = routeIds(params);
    const found = requireVersion(request, definitionId, versionId);
    if ("response" in found) return found.response;
    const conflict = checkIfMatch(request, found.version, true);
    if (conflict) return conflict;
    if (!canEditVersion(found.definition, found.version)) return apiProblem(request, 409, "VERSION_NOT_EDITABLE", "流程版本不可编辑", "已发布或已有实例的版本不能修改。 ");
    const body = await parseJsonBody<{ basicPatch?: Pick<ProcessBasicConfig, "name" | "starterGroups">; flow?: CompleteDesignerSnapshot["flow"] }>(request);
    if (body instanceof Response) return body;
    if (!body.flow) return apiProblem(request, 422, "VALIDATION_FAILED", "流程设计校验失败", "flow 不能为空。 ");
    const store = useProcessDefinitionStore.getState();
    if (body.basicPatch) {
      const basic = { ...found.version.basic, ...body.basicPatch };
      if (!store.updateVersionBasic(definitionId, versionId, basic)) {
        return apiProblem(request, 409, "VERSION_SAVE_FAILED", "保存失败", "流程基本信息没有保存。 ");
      }
    }
    if (!store.updateVersionFlowSnapshot(definitionId, versionId, body.flow)) {
      return apiProblem(request, 409, "VERSION_SAVE_FAILED", "保存失败", "流程图配置没有保存。 ");
    }
    const updated = versionById(definitionId, versionId)!;
    auditDefinition(auth.actor.id, auth.actor.name, "save-flow-designer", definitionById(definitionId)!, `保存 ${updated.version} 流程设计`);
    return apiOk(request, { version: structuredClone(updated), removedReferences: [] }, { headers: withEtag(updated) });
  }),

  http.post(`${API}/process-definitions/:definitionId/versions/:versionId/validate`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "config-definition:查看");
      if (auth.response) return auth.response;
      const { definitionId, versionId } = routeIds(params);
      const found = requireVersion(request, definitionId, versionId);
      if ("response" in found) return found.response;
      const conflict = checkIfMatch(request, found.version, true);
      if (conflict) return conflict;
      if (!useProcessDefinitionStore.getState().revalidateVersion(definitionId, versionId)) {
        return apiProblem(request, 409, "VERSION_VALIDATION_FAILED", "版本校验失败", "流程版本状态已经变化，请刷新后重试。 ");
      }
      const updated = versionById(definitionId, versionId)!;
      return apiOk(request, structuredClone(updated), { headers: withEtag(updated) });
    });
  }),

  http.post(`${API}/process-definitions/:definitionId/versions/:versionId/publish`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "config-definition:发布");
      if (auth.response) return auth.response;
      const { definitionId, versionId } = routeIds(params);
      const found = requireVersion(request, definitionId, versionId);
      if ("response" in found) return found.response;
      const conflict = checkIfMatch(request, found.version, true);
      if (conflict) return conflict;
      const body = await parseJsonBody<{ changeNote?: string }>(request);
      if (body instanceof Response) return body;
      if (!body.changeNote?.trim()) return apiProblem(request, 422, "CHANGE_NOTE_REQUIRED", "发布说明不能为空", "请填写本次发布内容。 ");
      if (!useProcessDefinitionStore.getState().publishVersion(definitionId, versionId, body.changeNote.trim())) {
        const checked = versionById(definitionId, versionId);
        return apiProblem(request, 422, "VALIDATION_FAILED", "版本校验未通过", "请修复所有校验问题后重新发布。", {
          errors: checked?.validation.issues.map((message, index) => ({ path: `validation.issues[${index}]`, code: "DESIGNER_VALIDATION", message })),
        });
      }
      const definition = definitionById(definitionId)!;
      const version = versionById(definitionId, versionId)!;
      auditDefinition(auth.actor.id, auth.actor.name, "publish", definition, `发布 ${definition.name} ${version.version}`);
      return apiOk(request, { definition, version }, { headers: withEtag(definition) });
    });
  }),

  http.post(`${API}/process-definitions/:definitionId/versions/:versionId/unpublish`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "config-definition:发布");
      if (auth.response) return auth.response;
      const { definitionId, versionId } = routeIds(params);
      const found = requireVersion(request, definitionId, versionId);
      if ("response" in found) return found.response;
      const conflict = checkIfMatch(request, found.definition, true);
      if (conflict) return conflict;
      const body = await parseJsonBody<{ reason?: string }>(request);
      if (body instanceof Response) return body;
      if (!body.reason?.trim()) return apiProblem(request, 422, "REASON_REQUIRED", "取消发布原因不能为空", "请填写取消发布原因。 ");
      const result = useProcessDefinitionStore.getState().unpublishVersion(definitionId, versionId, body.reason);
      if (result !== "unpublished") return apiProblem(request, 409, "PUBLISH_POINTER_CHANGED", "发布状态已经变化", "当前版本已不是发布版本。 ");
      const definition = definitionById(definitionId)!;
      const version = versionById(definitionId, versionId)!;
      auditDefinition(auth.actor.id, auth.actor.name, "unpublish", definition, `取消发布 ${definition.name} ${version.version}`);
      return apiOk(request, { definition, version }, { headers: withEtag(definition) });
    });
  }),

  http.delete(`${API}/process-definitions/:definitionId/versions/:versionId`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    const auth = requirePermission(request, "config-definition:删除");
    if (auth.response) return auth.response;
    const { definitionId, versionId } = routeIds(params);
    const found = requireVersion(request, definitionId, versionId);
    if ("response" in found) return found.response;
    const conflict = checkIfMatch(request, found.version, true);
    if (conflict) return conflict;
    const result = useProcessDefinitionStore.getState().deleteVersion(definitionId, versionId);
    if (result === "published") return apiProblem(request, 409, "VERSION_PUBLISHED", "发布版本不能删除", "请先取消发布该版本。 ");
    if (result === "has-instances") return apiProblem(request, 409, "VERSION_HAS_INSTANCES", "已有实例的版本不能删除", "历史实例需要继续读取该版本快照。 ");
    if (result === "not-found") return apiProblem(request, 404, "VERSION_NOT_FOUND", "流程版本不存在", "流程版本可能已被删除。 ");
    appendAuditEvent({ category: "definition", action: "delete-version", actorId: auth.actor.id, actorName: auth.actor.name, resourceType: "process-version", resourceId: versionId, summary: `删除流程版本 ${found.version.version}` });
    return apiNoContent(request);
  }),
];
