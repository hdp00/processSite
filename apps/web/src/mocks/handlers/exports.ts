import { http, HttpResponse } from "msw";
import type { ProcessExportJob } from "../../api/contracts";
import type { ProcessInstance } from "../../data/types";
import { getEffectiveVersion, useProcessDefinitionStore } from "../../state/useProcessDefinitionStore";
import { isSuperAdminPersona, usePrototypeStore } from "../../state/usePrototypeStore";
import { canUserViewInstance } from "../../state/workflowAccess";
import { createProcessListExcelFile } from "../../utils/processExcelExport";
import {
  apiOk,
  apiProblem,
  appendAuditEvent,
  applyMockScenario,
  parseJsonBody,
  requirePermission,
  withIdempotency,
} from "../runtime";

const API = "/api/v1";
const EXPORT_KEY = "flowpilot-mock-api-exports-v1";

interface ExportFilter {
  [key: string]: unknown;
  dateFrom: string;
  dateTo: string;
  q?: string;
  definitionId?: string;
  status?: string;
  initiatorId?: string;
  currentNode?: string;
  dynamicFilters?: Record<string, unknown>;
}

interface StoredExport extends ProcessExportJob {
  query: ExportFilter;
}

const readExports = () => {
  try {
    return JSON.parse(window.localStorage.getItem(EXPORT_KEY) ?? "[]") as StoredExport[];
  } catch {
    return [];
  }
};

const writeExports = (items: StoredExport[]) => window.localStorage.setItem(EXPORT_KEY, JSON.stringify(items.slice(0, 100)));

const instanceDate = (instance: ProcessInstance) => {
  const matched = instance.createdAt.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  return matched ? `${matched[1]}-${matched[2].padStart(2, "0")}-${matched[3].padStart(2, "0")}` : "";
};

const matchingInstances = (filter: ExportFilter, actorId: string) => {
  const q = filter.q?.trim().toLowerCase() ?? "";
  return usePrototypeStore.getState().instances.filter((instance) => {
    const date = instanceDate(instance);
    const dynamicMatch = Object.entries(filter.dynamicFilters ?? {}).every(([fieldId, expected]) => {
      if (expected === undefined || expected === null || expected === "") return true;
      const actual = instance.formValues?.[fieldId];
      return String(Array.isArray(actual) ? actual.join("/") : actual ?? "").toLowerCase().includes(String(expected).toLowerCase());
    });
    return canUserViewInstance(actorId, instance)
      && date >= filter.dateFrom && date <= filter.dateTo
      && (!q || `${instance.code}${instance.title}${instance.documentCode}${instance.initiator}`.toLowerCase().includes(q))
      && (!filter.definitionId || instance.definitionId === filter.definitionId)
      && (!filter.status || instance.status === filter.status)
      && (!filter.initiatorId || instance.initiatorId === filter.initiatorId)
      && (!filter.currentNode || instance.currentNode.includes(filter.currentNode))
      && dynamicMatch;
  });
};

const visibleExport = (id: string, actorId: string) => {
  const job = readExports().find((item) => item.id === id);
  return job && (job.requestedById === actorId || isSuperAdminPersona(actorId)) ? job : undefined;
};

const paramId = (value: string | readonly string[] | undefined) => String(Array.isArray(value) ? value[0] ?? "" : value ?? "");

export const exportHandlers = [
  http.post(`${API}/exports/process-instances`, async ({ request }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "work-list:查看");
      if (auth.response) return auth.response;
      const body = await parseJsonBody<{ filter?: ExportFilter }>(request);
      if (body instanceof Response) return body;
      const filter = body.filter;
      if (!filter?.dateFrom || !filter.dateTo) return apiProblem(request, 422, "DATE_RANGE_INCOMPLETE", "导出时间范围不完整", "dateFrom 和 dateTo 均为必填项。 ");
      if (filter.dateFrom > filter.dateTo) return apiProblem(request, 422, "DATE_RANGE_INVALID", "导出时间范围无效", "开始日期不能晚于结束日期。 ");
      if (!filter.definitionId) return apiProblem(request, 422, "DEFINITION_REQUIRED", "缺少流程定义", "当前原型导出必须指定 definitionId。 ");
      const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === filter.definitionId);
      const version = getEffectiveVersion(definition);
      if (!definition || !version) return apiProblem(request, 404, "DEFINITION_NOT_FOUND", "流程定义不存在", "未找到可用于导出的发布版本。 ");
      const instances = matchingInstances(filter, auth.actor.id);
      if (!instances.length) return apiProblem(request, 422, "EXPORT_EMPTY_RESULT", "当前查询没有可导出数据", "请调整查询条件后重试。 ");
      const file = createProcessListExcelFile({ definitionName: version.basic.name, systemFields: version.snapshot.systemFields, formFields: version.snapshot.form.fields, instances });
      if (!file) return apiProblem(request, 422, "EXPORT_NO_COLUMNS", "没有配置导出字段", "请先在流程版本中配置至少一个导出字段。 ");
      const now = new Date();
      const job: StoredExport = {
        id: globalThis.crypto.randomUUID(),
        definitionId: definition.id,
        requestedById: auth.actor.id,
        status: "completed",
        query: filter,
        rowCount: instances.length,
        fileName: file.fileName,
        createdAt: now.toISOString(),
        completedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      };
      writeExports([job, ...readExports()]);
      appendAuditEvent({ category: "instance", action: "create-export", actorId: auth.actor.id, actorName: auth.actor.name, resourceType: "process-export", resourceId: job.id, summary: `创建 ${instances.length} 条流程实例的 Excel 导出` });
      return apiOk(request, job, { status: 202, headers: { Location: `${API}/exports/${job.id}`, "Retry-After": "1" } });
    });
  }),
  http.get(`${API}/exports/:exportId`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "work-list:查看");
    if (auth.response) return auth.response;
    const job = visibleExport(paramId(params.exportId), auth.actor.id);
    return job ? apiOk(request, job, { headers: { "Retry-After": job.status === "completed" ? "0" : "1" } }) : apiProblem(request, 404, "EXPORT_NOT_FOUND", "导出任务不存在", "未找到指定导出任务，或当前用户无权访问。 ");
  }),
  http.get(`${API}/exports/:exportId/content`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "work-list:查看");
    if (auth.response) return auth.response;
    const job = visibleExport(paramId(params.exportId), auth.actor.id);
    if (!job) return apiProblem(request, 404, "EXPORT_NOT_FOUND", "导出任务不存在", "未找到指定导出任务，或当前用户无权访问。 ");
    if (job.status !== "completed") return apiProblem(request, 409, "EXPORT_NOT_READY", "导出文件尚未生成", "请稍后重新下载。 ");
    if (Date.parse(job.expiresAt) <= Date.now()) return apiProblem(request, 410, "EXPORT_EXPIRED", "导出文件已过期", "请重新创建导出任务。 ");
    const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === job.definitionId);
    const version = getEffectiveVersion(definition);
    const instances = matchingInstances(job.query, auth.actor.id);
    if (!definition || !version || !instances.length) return apiProblem(request, 409, "EXPORT_SOURCE_CHANGED", "导出数据已经变化", "Mock 数据已重置或当前账号的数据范围发生变化，请重新导出。 ");
    const file = createProcessListExcelFile({ definitionName: version.basic.name, systemFields: version.snapshot.systemFields, formFields: version.snapshot.form.fields, instances });
    if (!file) return apiProblem(request, 422, "EXPORT_NO_COLUMNS", "没有配置导出字段", "请先配置导出字段。 ");
    appendAuditEvent({ category: "instance", action: "download-export", actorId: auth.actor.id, actorName: auth.actor.name, resourceType: "process-export", resourceId: job.id, summary: `下载导出文件 ${file.fileName}` });
    return new HttpResponse(file.blob, { status: 200, headers: { "Content-Type": file.blob.type, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`, "Cache-Control": "no-store" } });
  }),
];
