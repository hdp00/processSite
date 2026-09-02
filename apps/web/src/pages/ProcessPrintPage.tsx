import { PaperClipOutlined, PrinterOutlined } from "@ant-design/icons";
import { Button, Empty } from "antd";
import { useNavigate, useParams } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import type { ReviewerProgress, WorkflowTask } from "../data/types";
import { usePrototypeStore } from "../state/usePrototypeStore";
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { findIdentityUser, useIdentityStore } from "../state/useIdentityStore";
import { formatRoundLabel } from "../utils/roundDisplay";
import { isDesignerFieldVisible, type StoredDesignerField, type StoredDesignerTableColumn } from "../utils/designerStorage";
import { displayDesignerChoiceValue } from "../utils/designerOptions";
import { resolveRuntimeAttachmentNames } from "../utils/attachmentDisplay";
import { formatDisplayDateTime } from "../utils/domainTime";

const reviewStatusClass: Record<ReviewerProgress["status"], string> = {
  待审核: "pending",
  已通过: "passed",
  已确认: "passed",
  已驳回: "rejected",
  已取消: "cancelled",
  已跳过: "cancelled",
};

const taskReviewStatus = (task: WorkflowTask): ReviewerProgress["status"] => {
  if (task.status === "已跳过") return "已跳过";
  if (task.status === "已取消") return "已取消";
  if (task.status === "未激活" || task.status === "待处理") return "待审核";
  if (task.action === "确认") return "已确认";
  if (task.action === "驳回") return "已驳回";
  return "已通过";
};

const printableValue = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(printableValue).filter(Boolean).join("、") || "—";
  if (typeof value === "string") return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return value && typeof value === "object" ? "已填写" : "—";
};

const printableFieldValue = (field: StoredDesignerField, value: unknown) =>
  ["select", "radio", "checkbox", "cascader"].includes(field.type)
    ? displayDesignerChoiceValue(field.options, value, { hierarchical: field.type === "cascader" }) || "—"
    : printableValue(value);

const printableColumnValue = (column: StoredDesignerTableColumn, value: unknown) =>
  column.type && column.type !== "text"
    ? displayDesignerChoiceValue(column.options, value) || "—"
    : printableValue(value);

export function ProcessPrintPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const instance = usePrototypeStore((state) => state.instances.find((item) => item.id === id));
  const tasks = usePrototypeStore((state) => state.tasks);
  const workflowGroups = useIdentityStore((state) => state.workflowGroups);
  const definition = useProcessDefinitionStore((state) => state.definitions.find((item) => item.id === instance?.definitionId));
  const version = definition?.versions.find((item) => item.id === instance?.versionId);

  if (!instance || instance.workflowType === "free") {
    return (
      <main className="print-preview-page print-preview-empty">
        <Empty description={instance?.workflowType === "free" ? "自由协作流程不提供 PDF 打印" : "未找到可打印的流程数据"} />
        <AppBackButton onClick={() => navigate(-1)} />
      </main>
    );
  }

  const visibleFields = version?.snapshot.form.fields.filter((field) => isDesignerFieldVisible(field, instance.formValues ?? {})) ?? [];
  const printableFields = visibleFields.filter((field) => !["attachment", "table"].includes(field.type));
  const tableFields = visibleFields.filter((field) => field.type === "table");
  const attachmentFields = visibleFields.filter((field) => field.type === "attachment");
  const attachmentNames = resolveRuntimeAttachmentNames({
    fields: attachmentFields,
    values: instance.formValues,
    fallbackNames: [
      ...(instance.attachmentNames ?? []),
      ...(!instance.attachmentNames?.length && instance.pdfName ? [instance.pdfName] : []),
    ],
  });
  const instanceTasks = tasks.filter((task) => task.instanceId === instance.id);
  const reviewedInstanceTasks = instanceTasks
    .filter((task) =>
      task.status === "已完成" &&
      Boolean(task.action) &&
      Boolean(task.completedAt || task.completedById || task.completedByName),
    )
    .sort((left, right) =>
      (left.completedAt ?? "9999-12-31 23:59").localeCompare(right.completedAt ?? "9999-12-31 23:59", "zh-CN")
      || left.round - right.round
      || left.nodeName.localeCompare(right.nodeName, "zh-CN"),
    );
  const modifiedFieldLabelsByTaskId = new Map(instanceTasks.map((task) => {
    const labels = [
      ...(task.submittedFieldChanges ?? []),
      ...(task.fieldRevisions ?? []).flatMap((revision) => revision.changes),
    ].map((change) => change.label.trim()).filter(Boolean);
    return [task.id, [...new Set(labels)]];
  }));

  return (
    <main className="print-preview-page">
      <div className="print-preview-toolbar no-print">
        <AppBackButton
          onClick={() => {
            if (window.opener) window.close();
            else navigate(-1);
          }}
        />
        <div>
          <strong>流程打印预览</strong>
          <span>附件仅显示名称，不打印附件内容</span>
        </div>
        <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>打印 / 另存为 PDF</Button>
      </div>

      <article className="process-print-document">
        <header className="process-print-header">
          <div className="process-print-brand">FlowPilot</div>
          <div className="process-print-heading">
            <h1>{instance.title}</h1>
          </div>
          <div className="process-print-code">
            <small>流程实例编号</small>
            <strong>{instance.code}</strong>
          </div>
        </header>

        <section className="print-section print-summary-section">
          <h2>流程基本信息</h2>
          <dl className="print-summary-grid">
            <div><dt>流程名称</dt><dd>{instance.template}</dd></div>
            <div><dt>流程版本</dt><dd>{instance.templateVersion}</dd></div>
            <div><dt>流程状态</dt><dd><span className={`print-status status-${instance.status}`}>{instance.status}</span></dd></div>
            {instance.round > 1 ? <div><dt>当前轮次</dt><dd>{formatRoundLabel(instance.round)}</dd></div> : null}
            <div><dt>发布人</dt><dd>{instance.initiator}（{instance.department}）</dd></div>
            <div><dt>发布时间</dt><dd>{formatDisplayDateTime(instance.createdAt)}</dd></div>
            <div><dt>当前节点</dt><dd>{instance.currentNode}</dd></div>
            <div><dt>最近更新</dt><dd>{formatDisplayDateTime(instance.updatedAt)}</dd></div>
          </dl>
        </section>

        <section className="print-section">
          <h2>流程表单</h2>
          <table className="print-form-table">
            <tbody>
              {printableFields.length ? printableFields.map((field) => (
                <tr key={field.id}><th>{field.label}</th><td colSpan={3} className="print-multiline">{printableFieldValue(field, instance.formValues?.[field.id])}</td></tr>
              )) : (
                <><tr><th>标题</th><td colSpan={3}>{instance.title}</td></tr><tr><th>说明</th><td colSpan={3}>{instance.description}</td></tr></>
              )}
            </tbody>
          </table>
          {tableFields.map((field) => {
            const rows = Array.isArray(instance.formValues?.[field.id]) ? instance.formValues?.[field.id] as Array<Record<string, unknown>> : [];
            return <div key={field.id}><h3>{field.label}</h3><table className="print-data-table"><thead><tr>{field.columns?.map((column) => <th key={column.id}>{column.label}</th>)}</tr></thead><tbody>{rows.length ? rows.map((row, index) => <tr key={String(row.key ?? index)}>{field.columns?.map((column) => <td key={column.id}>{printableColumnValue(column, row[column.id])}</td>)}</tr>) : <tr><td colSpan={Math.max(field.columns?.length ?? 1, 1)}>—</td></tr>}</tbody></table></div>;
          })}
        </section>

        {attachmentFields.length ? <section className="print-section">
          <h2>附件清单</h2>
          {attachmentNames.length ? attachmentNames.map((name) => <div className="print-file-row" key={name}><PaperClipOutlined /><div><strong>{name}</strong><span>仅列出附件名称，附件正文不随流程打印</span></div></div>) : <p className="print-empty-text">无附件</p>}
        </section> : null}

        {reviewedInstanceTasks.length ? (
          <section className="print-section">
            <h2>审批进度与审核信息</h2>
            <table className="print-review-table">
              <thead>
                <tr><th>审批节点</th><th>处理方式</th><th>流程权限组</th><th>默认责任人</th><th>实际处理人</th><th>处理结果</th><th>处理时间</th><th>处理说明</th></tr>
              </thead>
              <tbody>
                {reviewedInstanceTasks.map((task) => {
                const reviewer = instance.reviewers.find((item) => item.key === task.nodeId && task.round === instance.round);
                const node = version?.snapshot.flow.nodes.find((item) => item.id === task.nodeId);
                const status = taskReviewStatus(task);
                const groupName = workflowGroups.find((group) => group.id === task.permissionGroupId)?.name ?? reviewer?.group ?? task.permissionGroupId;
                const isSubstitute = Boolean(task.completedById && task.defaultAssigneeId && task.completedById !== task.defaultAssigneeId);
                const modifiedFieldLabels = modifiedFieldLabelsByTaskId.get(task.id) ?? [];
                return <tr key={task.id}>
                  <td>{task.round > 1 ? <>{formatRoundLabel(task.round)}<br /></> : null}{task.nodeName}</td>
                  <td>{node?.data?.handlingMode === "confirmation" ? "确认" : "审批"}</td>
                  <td>{groupName}</td>
                  <td>{task.defaultAssigneeName ?? findIdentityUser(task.defaultAssigneeId ?? "")?.name ?? "组内共享"}</td>
                  <td>{task.completedAt ? <>{task.completedByName ?? "—"}{isSubstitute ? "（代办）" : ""}</> : "—"}</td>
                  <td><span className={`print-review-status ${reviewStatusClass[status]}`}>{status}</span></td>
                  <td>{formatDisplayDateTime(task.completedAt ?? task.conditionEvaluatedAt)}</td>
                  <td className="print-multiline">
                    <div>{task.comment?.trim() || "—"}</div>
                    {modifiedFieldLabels.length ? <div className="print-review-changes"><strong>修改字段：</strong>{modifiedFieldLabels.join("、")}</div> : null}
                  </td>
                </tr>;
                })}
              </tbody>
            </table>
          </section>
        ) : null}

        <footer className="process-print-footer">
          <span>打印时间：{formatDisplayDateTime(new Date().toISOString())}</span>
          <span>此文件由 FlowPilot 流程审核中心生成</span>
        </footer>
      </article>
    </main>
  );
}
