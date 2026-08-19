import { http } from "msw";
import type { AuditEvent } from "../../api/contracts";
import { usePrototypeStore } from "../../state/usePrototypeStore";
import { collectRuntimeAuditEvents } from "../../utils/runtimeAudit";
import {
  apiOk,
  applyMockScenario,
  pageQuery,
  paginate,
  readAuditEvents,
  requirePermission,
} from "../runtime";

const API = "/api/v1";

const runtimeAuditEvents = (): AuditEvent[] => {
  const { tasks, instances } = usePrototypeStore.getState();
  return collectRuntimeAuditEvents(instances, tasks);
};

const comparableTime = (value: string) => {
  const parsed = Date.parse(value.replaceAll("/", "-"));
  return Number.isFinite(parsed) ? parsed : 0;
};

export const auditHandlers = [
  http.get(`${API}/audit-events`, async ({ request }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "system-audit:查看");
    if (auth.response) return auth.response;
    const pagination = pageQuery(request, 50);
    if ("response" in pagination) return pagination.response;
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const category = url.searchParams.get("category");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const fromTime = from ? Date.parse(from) : undefined;
    const toTime = to ? Date.parse(to) : undefined;
    const byId = new Map([...readAuditEvents(), ...runtimeAuditEvents()].map((item) => [item.id, item]));
    const items = Array.from(byId.values())
      .filter((item) => !q || `${item.action}${item.actorName ?? ""}${item.resourceId}${item.summary}`.toLowerCase().includes(q))
      .filter((item) => !category || item.category === category)
      .filter((item) => {
        const timestamp = comparableTime(item.occurredAt);
        return (!Number.isFinite(fromTime) || timestamp >= Number(fromTime)) && (!Number.isFinite(toTime) || timestamp <= Number(toTime));
      })
      .sort((left, right) => comparableTime(right.occurredAt) - comparableTime(left.occurredAt));
    return apiOk(request, paginate(items, pagination.number, pagination.size));
  }),
  http.get(`${API}/audit-events/:auditEventId`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "system-audit:查看");
    if (auth.response) return auth.response;
    const id = String(Array.isArray(params.auditEventId) ? params.auditEventId[0] ?? "" : params.auditEventId ?? "");
    const event = [...readAuditEvents(), ...runtimeAuditEvents()].find((item) => item.id === id);
    return event ? apiOk(request, event) : new Response(JSON.stringify({
      type: "https://flowpilot.local/problems/audit-event-not-found",
      title: "审计事件不存在",
      status: 404,
      detail: "未找到指定审计事件。",
      instance: new URL(request.url).pathname,
      code: "AUDIT_EVENT_NOT_FOUND",
      traceId: request.headers.get("X-Request-Id") ?? "audit",
    }), { status: 404, headers: { "Content-Type": "application/problem+json" } });
  }),
];
