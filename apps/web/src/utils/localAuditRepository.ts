import type { AuditEvent } from "../api/contracts";

export const LOCAL_AUDIT_STORAGE_KEY = "flowpilot-mock-api-audit-v1";

export const readLocalAuditEvents = (): AuditEvent[] => {
  try {
    return JSON.parse(window.localStorage.getItem(LOCAL_AUDIT_STORAGE_KEY) ?? "[]") as AuditEvent[];
  } catch {
    return [];
  }
};

export const writeLocalAuditEvents = (events: AuditEvent[]) => {
  window.localStorage.setItem(LOCAL_AUDIT_STORAGE_KEY, JSON.stringify(events));
};
