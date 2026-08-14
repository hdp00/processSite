import { create } from "zustand";
import { persist } from "zustand/middleware";
import { initialInstances, initialNotices } from "../data/mock";
import type { FreeFlowEntry, NoticeItem, ProcessInstance } from "../data/types";
import { getEffectiveVersion, useProcessDefinitionStore } from "./useProcessDefinitionStore";
import {
  extractInstancePrefix,
  issueNextInstanceNumber,
  normalizeLegacyInstanceNumber,
  resetInstanceNumberSequences,
} from "../utils/instanceNumber";

type ReviewAction = "pass" | "reject";
type RepublishChanges = Partial<
  Pick<ProcessInstance, "title" | "documentCode" | "documentType" | "documentLevel" | "description" | "pdfName">
>;
export type PersonaId = "superadmin" | "wangmin" | "zhangwei" | "lina" | "zhaolei" | "admin" | "hejing";
export const SUPER_ADMIN_PERSONA_ID: PersonaId = "superadmin";
export const isSuperAdminPersona = (personaId: PersonaId) => personaId === SUPER_ADMIN_PERSONA_ID;

export interface FreeFlowCreateInput {
  title: string;
  category: string;
  priority: ProcessInstance["priority"];
  description: string;
  initialContent: string;
  attachmentName?: string;
  assignee: string;
  instancePrefix?: string;
}

export interface FreeFlowInitialChanges {
  title: string;
  category: string;
  priority: ProcessInstance["priority"];
  description: string;
  initialContent: string;
}

export const personas: Array<{
  id: PersonaId;
  name: string;
  role: string;
  reviewerKey?: "rd" | "qa" | "production";
}> = [
  { id: "wangmin", name: "王敏", role: "文控专员" },
  { id: "zhangwei", name: "张伟", role: "研发审核人", reviewerKey: "rd" },
  { id: "lina", name: "林晓", role: "质量审核人", reviewerKey: "qa" },
  { id: "zhaolei", name: "赵磊", role: "生产审核人", reviewerKey: "production" },
  { id: "admin", name: "周杰", role: "系统管理员" },
  { id: "hejing", name: "何静", role: "只读查看者" },
  { id: "superadmin", name: "超级管理员", role: "系统内置 · 全部权限" },
];

interface PrototypeState {
  authenticated: boolean;
  personaId: PersonaId;
  instances: ProcessInstance[];
  notices: NoticeItem[];
  login: (personaId?: PersonaId) => void;
  logout: () => void;
  switchPersona: (personaId: PersonaId) => void;
  markAllNoticesRead: () => void;
  reviewInstance: (id: string, action: ReviewAction, comment: string, documentLevel?: string) => void;
  closeInstance: (id: string, reason: string) => void;
  updateUnreviewedInstance: (id: string, changes: RepublishChanges) => void;
  republishInstance: (id: string, changes: RepublishChanges) => void;
  copyCompletedInstance: (sourceId: string, title: string) => string | null;
  createFreeFlow: (input: FreeFlowCreateInput) => string;
  replyFreeFlow: (id: string, content: string) => void;
  transferFreeFlow: (id: string, content: string, nextAssignee: string) => void;
  editFreeFlowReply: (id: string, entryId: string, content: string) => void;
  updateFreeFlowInitial: (id: string, changes: FreeFlowInitialChanges) => void;
  forceReassignFreeFlow: (id: string, reason: string, assignee: string) => void;
  closeFreeFlow: (id: string, reason: string) => void;
  reopenFreeFlow: (id: string, reason: string, assignee: string) => void;
  resetDemo: () => void;
}

const nowText = () =>
  new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date())
    .replaceAll("/", "-");

const normalizeTemplateVersion = (value: string) => {
  const matched = value.match(/^v(\d+)/i);
  return matched ? `V${Number(matched[1])}` : value;
};

const currentPersona = (personaId: PersonaId) =>
  personas.find((item) => item.id === personaId) ?? personas[0];

const freeEntry = (
  type: FreeFlowEntry["type"],
  actor: string,
  changes: Partial<FreeFlowEntry> = {},
): FreeFlowEntry => ({
  id: `free-entry-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  type,
  actor,
  time: nowText(),
  ...changes,
});

export const usePrototypeStore = create<PrototypeState>()(
  persist(
    (set) => ({
      authenticated: false,
      personaId: "lina",
      instances: initialInstances,
      notices: initialNotices,
      login: (personaId = "lina") => set({ authenticated: true, personaId }),
      logout: () => set({ authenticated: false }),
      switchPersona: (personaId) => set({ personaId }),
      markAllNoticesRead: () =>
        set((state) => ({ notices: state.notices.map((notice) => ({ ...notice, read: true })) })),
      reviewInstance: (id, action, comment, documentLevel) =>
        set((state) => {
          const actionAt = nowText();
          const instances = state.instances.map((instance) => {
            if (instance.id !== id || instance.status !== "审核中") return instance;

            const persona = personas.find((item) => item.id === state.personaId) ?? personas[2];
            const reviewerKey = isSuperAdminPersona(state.personaId)
              ? instance.reviewers.find((reviewer) => reviewer.status === "待审核")?.key
              : persona.reviewerKey;
            const reviewers = instance.reviewers.map((reviewer) => {
              if (reviewer.key === reviewerKey && reviewer.status === "待审核") {
                return {
                  ...reviewer,
                  status: action === "pass" ? ("已通过" as const) : ("已驳回" as const),
                  actionAt,
                  comment: comment || (action === "pass" ? "同意，按修订内容执行。" : "请修正后重新发布。"),
                  substitute: Boolean(instance.designatedReviewer && instance.designatedReviewer !== persona.name),
                  name: persona.name,
                };
              }
              if (action === "reject" && reviewer.status === "待审核") {
                return { ...reviewer, status: "已取消" as const };
              }
              return reviewer;
            });

            const allPassed = reviewers.every((reviewer) => reviewer.status === "已通过");
            return {
              ...instance,
              documentLevel: documentLevel ?? instance.documentLevel,
              reviewers,
              updatedAt: actionAt,
              status: action === "reject" ? ("驳回待处理" as const) : allPassed ? ("已完成" as const) : instance.status,
              currentNode:
                action === "reject" ? "等待发布方重新发布" : allPassed ? "流程结束" : "研发 / 质量 / 生产并行审核",
            };
          });

          const target = state.instances.find((instance) => instance.id === id);
          const notice: NoticeItem = {
            id: `notice-${Date.now()}`,
            title: action === "pass" ? "审核意见已提交" : "流程已驳回文控处理",
            detail: target?.title ?? "流程状态已更新",
            time: "刚刚",
            read: false,
            instanceId: id,
          };
          return { instances, notices: [notice, ...state.notices] };
        }),
      closeInstance: (id, reason) =>
        set((state) => ({
          instances: state.instances.map((instance) =>
            instance.id === id
              ? {
                  ...instance,
                  status: "已关闭",
                  currentNode: "流程已关闭",
                  updatedAt: nowText(),
                  description: `${instance.description}（关闭说明：${reason}）`,
                  reviewers: instance.reviewers.map((reviewer) =>
                    reviewer.status === "待审核" ? { ...reviewer, status: "已取消" } : reviewer,
                  ),
                }
              : instance,
          ),
        })),
      updateUnreviewedInstance: (id, changes) =>
        set((state) => ({
          instances: state.instances.map((instance) => {
            const hasReviewAction = instance.reviewers.some(
              (reviewer) => reviewer.status === "已通过" || reviewer.status === "已驳回",
            );
            if (instance.id !== id || instance.status !== "审核中" || hasReviewAction) return instance;
            return {
              ...instance,
              ...changes,
              updatedAt: nowText(),
            };
          }),
        })),
      republishInstance: (id, changes) =>
        set((state) => ({
          instances: state.instances.map((instance) =>
            instance.id === id
              ? {
                  ...instance,
                  ...changes,
                  status: "审核中",
                  currentNode: "研发 / 质量 / 生产并行审核",
                  round: instance.round + 1,
                  updatedAt: nowText(),
                  reviewers: instance.reviewers.map((reviewer) => ({
                    ...reviewer,
                    status: "待审核",
                    actionAt: undefined,
                    comment: undefined,
                    substitute: undefined,
                  })),
                }
              : instance,
          ),
        })),
      copyCompletedInstance: (sourceId, title) => {
        let createdId: string | null = null;
        set((state) => {
          const source = state.instances.find((instance) => instance.id === sourceId);
          if (!source || source.status !== "已完成" || (state.personaId !== "wangmin" && !isSuperAdminPersona(state.personaId))) return state;

          const persona = personas.find((item) => item.id === state.personaId) ?? personas[0];
          const timestamp = Date.now();
          const definitionId = source.template.includes("测试报告") ? "test-report-review" : "pdf-review";
          const currentDefinition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === definitionId);
          const currentPrefix = getEffectiveVersion(currentDefinition)?.basic.instancePrefix;
          const prefix = currentPrefix || extractInstancePrefix(source.code) || "DOC";
          createdId = `copy-${timestamp}`;
          const createdAt = nowText();
          const copied: ProcessInstance = {
            ...source,
            id: createdId,
            code: issueNextInstanceNumber(prefix, state.instances.map((item) => item.code)),
            title: title.trim() || `${source.title}（复制）`,
            status: "审核中",
            initiator: persona.name,
            department: "文控中心",
            createdAt,
            updatedAt: createdAt,
            round: 1,
            currentNode: "研发 / 质量 / 生产并行审核",
            priority: "普通",
            designatedReviewer: undefined,
            designatedReviewerId: undefined,
            pdfName: "待补充附件",
            pdfSize: "—",
            reviewers: source.reviewers.map((reviewer) => ({
              ...reviewer,
              status: "待审核",
              actionAt: undefined,
              comment: undefined,
              substitute: undefined,
            })),
          };
          return { instances: [copied, ...state.instances] };
        });
        return createdId;
      },
      createFreeFlow: (input) => {
        const createdId = `free-${Date.now()}`;
        set((state) => {
          const persona = currentPersona(state.personaId);
          const createdAt = nowText();
          const created: ProcessInstance = {
            id: createdId,
            workflowType: "free",
            code: issueNextInstanceNumber(input.instancePrefix ?? "ISSUE", state.instances.map((item) => item.code)),
            title: input.title.trim(),
            template: "自由协作事项流程",
            templateVersion: getEffectiveVersion(useProcessDefinitionStore.getState().definitions.find((item) => item.type === "free"))?.version ?? "V1",
            status: "进行中",
            initiator: persona.name,
            department: persona.role,
            createdAt,
            updatedAt: createdAt,
            round: 1,
            currentNode: `${input.assignee}受理中`,
            currentAssignee: input.assignee,
            designatedReviewer: input.assignee,
            priority: input.priority,
            description: input.description.trim(),
            pdfName: input.attachmentName || "无附件",
            pdfSize: input.attachmentName ? "待上传" : "—",
            documentCode: `ISSUE-${String(Date.now()).slice(-6)}`,
            documentType: input.category,
            documentLevel: "内部事项",
            revision: "—",
            category: input.category,
            participants: [persona.name, input.assignee],
            reviewers: [],
            freeTimeline: [
              freeEntry("created", persona.name, {
                content: input.initialContent,
                assignee: input.assignee,
              }),
            ],
          };
          const notice: NoticeItem = {
            id: `notice-${Date.now()}`,
            title: `新事项已指派给${input.assignee}`,
            detail: created.title,
            time: "刚刚",
            read: false,
            instanceId: createdId,
          };
          return { instances: [created, ...state.instances], notices: [notice, ...state.notices] };
        });
        return createdId;
      },
      replyFreeFlow: (id, content) =>
        set((state) => {
          const persona = currentPersona(state.personaId);
          const actionAt = nowText();
          return {
            instances: state.instances.map((instance) => {
              const canReply =
                instance.workflowType === "free" &&
                instance.status === "进行中" &&
                (instance.participants?.includes(persona.name) || state.personaId === "admin" || isSuperAdminPersona(state.personaId));
              if (instance.id !== id || !canReply) return instance;
              return {
                ...instance,
                updatedAt: actionAt,
                participants: isSuperAdminPersona(state.personaId)
                  ? instance.participants
                  : [...new Set([...(instance.participants ?? []), persona.name])],
                freeTimeline: [
                  ...(instance.freeTimeline ?? []),
                  freeEntry("reply", persona.name, { content }),
                ],
              };
            }),
          };
        }),
      transferFreeFlow: (id, content, nextAssignee) =>
        set((state) => {
          const persona = currentPersona(state.personaId);
          const actionAt = nowText();
          const target = state.instances.find((instance) => instance.id === id);
          const canTransfer =
            target?.workflowType === "free" &&
            target.status === "进行中" &&
            (target.currentAssignee === persona.name || isSuperAdminPersona(state.personaId));
          if (!target || !canTransfer) return state;
          const entries: FreeFlowEntry[] = [
            ...(target.freeTimeline ?? []),
            freeEntry("reply", persona.name, { content, assignee: nextAssignee }),
            freeEntry("assigned", persona.name, { assignee: nextAssignee }),
          ];
          return {
            instances: state.instances.map((instance) =>
              instance.id === id
                ? {
                    ...instance,
                    currentAssignee: nextAssignee,
                    designatedReviewer: nextAssignee,
                    currentNode: `${nextAssignee}受理中`,
                    updatedAt: actionAt,
                    participants: [...new Set([...(instance.participants ?? []), nextAssignee])],
                    freeTimeline: entries,
                  }
                : instance,
            ),
            notices: [
              {
                id: `notice-${Date.now()}`,
                title: `${persona.name}向你转交了一项事项`,
                detail: target.title,
                time: "刚刚",
                read: false,
                instanceId: id,
              },
              ...state.notices,
            ],
          };
        }),
      editFreeFlowReply: (id, entryId, content) =>
        set((state) => {
          const persona = currentPersona(state.personaId);
          const editedAt = nowText();
          return {
            instances: state.instances.map((instance) => {
              if (instance.id !== id || instance.workflowType !== "free" || instance.status !== "进行中") return instance;
              return {
                ...instance,
                updatedAt: editedAt,
                freeTimeline: (instance.freeTimeline ?? []).map((entry) =>
                  entry.id === entryId && entry.type === "reply" && entry.actor === persona.name
                    ? {
                        ...entry,
                        content,
                        editedAt,
                        revisions: [
                          ...(entry.revisions ?? []),
                          { content: entry.content ?? "", editedAt },
                        ],
                      }
                    : entry,
                ),
              };
            }),
          };
        }),
      updateFreeFlowInitial: (id, changes) =>
        set((state) => {
          const persona = currentPersona(state.personaId);
          const actionAt = nowText();
          return {
            instances: state.instances.map((instance) => {
              if (
                instance.id !== id ||
                instance.workflowType !== "free" ||
                instance.status !== "进行中" ||
                instance.initiator !== persona.name
              ) return instance;
              const originalInitialContent = instance.freeTimeline?.find((entry) => entry.type === "created")?.content ?? "";
              const fieldChanges = [
                instance.title !== changes.title ? { field: "标题", before: instance.title, after: changes.title } : null,
                instance.category !== changes.category ? { field: "事项分类", before: instance.category ?? "—", after: changes.category } : null,
                instance.priority !== changes.priority ? { field: "优先级", before: instance.priority, after: changes.priority } : null,
                instance.description !== changes.description ? { field: "事项摘要", before: instance.description, after: changes.description } : null,
                originalInitialContent !== changes.initialContent ? { field: "初始说明", before: "原富文本内容", after: "新富文本内容" } : null,
              ].filter((change): change is { field: string; before: string; after: string } => Boolean(change));
              return {
                ...instance,
                title: changes.title,
                category: changes.category,
                documentType: changes.category,
                priority: changes.priority,
                description: changes.description,
                updatedAt: actionAt,
                freeTimeline: [
                  ...(instance.freeTimeline ?? []).map((entry) =>
                    entry.type === "created"
                      ? {
                          ...entry,
                          content: changes.initialContent,
                          editedAt: actionAt,
                          revisions: originalInitialContent !== changes.initialContent
                            ? [...(entry.revisions ?? []), { content: originalInitialContent, editedAt: actionAt }]
                            : entry.revisions,
                        }
                      : entry,
                  ),
                  freeEntry("form-edited", persona.name, {
                    content: `修改了${fieldChanges.map((change) => change.field).join("、") || "初始表单"}`,
                    fieldChanges,
                  }),
                ],
              };
            }),
          };
        }),
      forceReassignFreeFlow: (id, reason, assignee) =>
        set((state) => {
          const persona = currentPersona(state.personaId);
          const actionAt = nowText();
          return {
            instances: state.instances.map((instance) => {
              const canReassign =
                instance.id === id &&
                instance.workflowType === "free" &&
                instance.status === "进行中" &&
                (state.personaId === "wangmin" || state.personaId === "admin" || isSuperAdminPersona(state.personaId));
              if (!canReassign) return instance;
              return {
                ...instance,
                currentAssignee: assignee,
                designatedReviewer: assignee,
                currentNode: `${assignee}受理中`,
                updatedAt: actionAt,
                participants: [...new Set([...(instance.participants ?? []), assignee])],
                freeTimeline: [
                  ...(instance.freeTimeline ?? []),
                  freeEntry("reassigned", persona.name, {
                    content: reason,
                    assignee,
                    previousAssignee: instance.currentAssignee,
                  }),
                ],
              };
            }),
          };
        }),
      closeFreeFlow: (id, reason) =>
        set((state) => {
          const persona = currentPersona(state.personaId);
          const actionAt = nowText();
          return {
            instances: state.instances.map((instance) => {
              const canClose =
                instance.workflowType === "free" &&
                instance.status === "进行中" &&
                (instance.currentAssignee === persona.name || state.personaId === "wangmin" || state.personaId === "admin" || isSuperAdminPersona(state.personaId));
              if (instance.id !== id || !canClose) return instance;
              return {
                ...instance,
                status: "已关闭",
                currentAssignee: undefined,
                designatedReviewer: undefined,
                currentNode: "事项已关闭",
                updatedAt: actionAt,
                freeTimeline: [...(instance.freeTimeline ?? []), freeEntry("closed", persona.name, { content: reason })],
              };
            }),
          };
        }),
      reopenFreeFlow: (id, reason, assignee) =>
        set((state) => {
          const persona = currentPersona(state.personaId);
          const actionAt = nowText();
          return {
            instances: state.instances.map((instance) => {
              const canReopen =
                instance.workflowType === "free" &&
                instance.status === "已关闭" &&
                (instance.participants?.includes(persona.name) || state.personaId === "wangmin" || state.personaId === "admin" || isSuperAdminPersona(state.personaId));
              if (instance.id !== id || !canReopen) return instance;
              return {
                ...instance,
                status: "进行中",
                currentAssignee: assignee,
                designatedReviewer: assignee,
                currentNode: `${assignee}受理中`,
                updatedAt: actionAt,
                participants: [...new Set([...(instance.participants ?? []), persona.name, assignee])],
                freeTimeline: [
                  ...(instance.freeTimeline ?? []),
                  freeEntry("reopened", persona.name, { content: reason, assignee }),
                ],
              };
            }),
          };
        }),
      resetDemo: () => {
        resetInstanceNumberSequences();
        set((state) => ({
          instances: initialInstances,
          notices: initialNotices,
          authenticated: true,
          personaId: state.personaId,
        }));
      },
    }),
    {
      name: "flowpilot-prototype-v5",
      version: 8,
      migrate: (persisted) => {
        const state = persisted as PrototypeState;
        const existing = (state.instances ?? []).map((instance) => ({
          ...instance,
          code: normalizeLegacyInstanceNumber(instance.code),
          templateVersion: normalizeTemplateVersion(instance.templateVersion),
        }));
        const missingFreeInstances = initialInstances.filter(
          (instance) => instance.workflowType === "free" && !existing.some((item) => item.id === instance.id),
        );
        return { ...state, instances: [...existing, ...missingFreeInstances] };
      },
    },
  ),
);
