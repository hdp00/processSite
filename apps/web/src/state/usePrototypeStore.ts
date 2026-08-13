import { create } from "zustand";
import { persist } from "zustand/middleware";
import { initialInstances, initialNotices } from "../data/mock";
import type { NoticeItem, ProcessInstance } from "../data/types";

type ReviewAction = "pass" | "reject";
type RepublishChanges = Partial<
  Pick<ProcessInstance, "title" | "documentCode" | "documentType" | "documentLevel" | "description" | "pdfName">
>;
export type PersonaId = "wangmin" | "zhangwei" | "lina" | "zhaolei" | "admin" | "hejing";

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
  copyCompletedInstance: (sourceId: string, title: string, copyAttachment: boolean) => string | null;
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
            const reviewers = instance.reviewers.map((reviewer) => {
              if (reviewer.key === persona.reviewerKey && reviewer.status === "待审核") {
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
      copyCompletedInstance: (sourceId, title, copyAttachment) => {
        let createdId: string | null = null;
        set((state) => {
          const source = state.instances.find((instance) => instance.id === sourceId);
          if (!source || source.status !== "已完成" || state.personaId !== "wangmin") return state;

          const persona = personas.find((item) => item.id === state.personaId) ?? personas[0];
          const timestamp = Date.now();
          const prefix = source.template.includes("测试报告") ? "TR" : "PDF";
          createdId = `copy-${timestamp}`;
          const createdAt = nowText();
          const copied: ProcessInstance = {
            ...source,
            id: createdId,
            code: `${prefix}-${new Date().getFullYear()}-COPY-${String(timestamp).slice(-6)}`,
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
            pdfName: copyAttachment ? source.pdfName : "待补充附件",
            pdfSize: copyAttachment ? source.pdfSize : "—",
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
      resetDemo: () => set((state) => ({
        instances: initialInstances,
        notices: initialNotices,
        authenticated: true,
        personaId: state.personaId,
      })),
    }),
    { name: "flowpilot-prototype-v5" },
  ),
);
