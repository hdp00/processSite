import { http } from "msw";
import type { ProcessExcelDataFilter } from "../../api/contracts";
import type { ProcessInstance } from "../../data/types";
import { getPublishedVersion, useProcessDefinitionStore } from "../../state/useProcessDefinitionStore";
import { usePrototypeStore } from "../../state/usePrototypeStore";
import { canUserViewInstance } from "../../state/workflowAccess";
import { buildProcessExcelDataset } from "../../utils/processExcelExport";
import {
  apiOk,
  apiProblem,
  appendAuditEvent,
  applyMockScenario,
  parseJsonBody,
  requirePermission,
} from "../runtime";

const API = "/api/v1";
const MAX_EXPORT_ROWS = 10_000;

const instanceDate = (instance: ProcessInstance) => {
  const matched = instance.createdAt.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  return matched ? `${matched[1]}-${matched[2].padStart(2, "0")}-${matched[3].padStart(2, "0")}` : "";
};

const matchingInstances = (filter: ProcessExcelDataFilter, actorId: string) => {
  const q = filter.q?.trim().toLowerCase() ?? "";
  return usePrototypeStore.getState().instances.filter((instance) => {
    const date = instanceDate(instance);
    const dynamicMatch = Object.entries(filter.dynamicFilters ?? {}).every(([fieldId, expected]) => {
      if (expected === undefined || expected === null || expected === "") return true;
      const actual = instance.formValues?.[fieldId];
      return String(Array.isArray(actual) ? actual.join("/") : actual ?? "")
        .toLowerCase()
        .includes(String(expected).toLowerCase());
    });
    return canUserViewInstance(actorId, instance)
      && date >= filter.dateFrom
      && date <= filter.dateTo
      && (!q || `${instance.code}${instance.title}${instance.documentCode}${instance.initiator}`.toLowerCase().includes(q))
      && instance.definitionId === filter.definitionId
      && (!filter.status || instance.status === filter.status)
      && (!filter.initiatorId || instance.initiatorId === filter.initiatorId)
      && (!filter.currentNode || instance.currentNode.includes(filter.currentNode))
      && dynamicMatch;
  });
};

export const exportHandlers = [
  http.post(`${API}/exports/process-instances/data`, async ({ request }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "work-list:查看");
    if (auth.response) return auth.response;
    const body = await parseJsonBody<{ filter?: ProcessExcelDataFilter }>(request);
    if (body instanceof Response) return body;
    const filter = body.filter;
    if (!filter?.dateFrom || !filter.dateTo) {
      return apiProblem(request, 422, "DATE_RANGE_INCOMPLETE", "导出时间范围不完整", "dateFrom 和 dateTo 均为必填项。");
    }
    if (filter.dateFrom > filter.dateTo) {
      return apiProblem(request, 422, "DATE_RANGE_INVALID", "导出时间范围无效", "开始日期不能晚于结束日期。");
    }
    if (!filter.definitionId) {
      return apiProblem(request, 422, "DEFINITION_REQUIRED", "缺少流程定义", "导出必须指定 definitionId。");
    }

    const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === filter.definitionId);
    const version = getPublishedVersion(definition);
    if (!definition || !version) {
      return apiProblem(request, 404, "DEFINITION_NOT_FOUND", "流程定义不存在", "未找到可用于导出的发布版本。");
    }

    const instances = matchingInstances(filter, auth.actor.id);
    if (!instances.length) {
      return apiProblem(request, 422, "EXPORT_EMPTY_RESULT", "当前查询没有可导出数据", "请调整查询条件后重试。");
    }
    if (instances.length > MAX_EXPORT_ROWS) {
      return apiProblem(request, 422, "EXPORT_ROW_LIMIT_EXCEEDED", "导出数据量超过上限", `单次最多导出 ${MAX_EXPORT_ROWS.toLocaleString("zh-CN")} 条，请缩小查询范围。`);
    }

    const dataset = buildProcessExcelDataset({
      definitionId: definition.id,
      definitionName: version.basic.name,
      versionId: version.id,
      versionLabel: version.version,
      systemFields: version.snapshot.systemFields,
      formFields: version.snapshot.form.fields,
      instances,
    });
    if (!dataset.columns.length) {
      return apiProblem(request, 422, "EXPORT_NO_COLUMNS", "没有配置导出字段", "请先在流程版本中配置至少一个导出字段。");
    }

    appendAuditEvent({
      category: "instance",
      action: "request-export-data",
      actorId: auth.actor.id,
      actorName: auth.actor.name,
      resourceType: "process-definition",
      resourceId: definition.id,
      summary: `获取 ${instances.length} 条流程实例的 Excel 导出数据`,
      details: { filter, rowCount: instances.length, columnCount: dataset.columns.length },
    });
    return apiOk(request, dataset);
  }),
];
