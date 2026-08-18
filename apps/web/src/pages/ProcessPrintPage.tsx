import { FilePdfOutlined, PrinterOutlined } from "@ant-design/icons";
import { Button, Empty, Space, Tag } from "antd";
import { useNavigate, useParams } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import type { ReviewerProgress, WorkflowTask } from "../data/types";
import { usePrototypeStore } from "../state/usePrototypeStore";
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { findIdentityUser, useIdentityStore } from "../state/useIdentityStore";
import type { StoredNodeEmailNotification } from "../utils/designerStorage";

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

const emailNotificationText = (notification?: StoredNodeEmailNotification) => {
  if (!notification?.enabled) return "不发送";
  const recipients = [
    notification.notifyReviewers ? "审核人" : "",
    notification.notifyInitiator ? "发起人" : "",
    ...(notification.extraUserIds ?? []).map((userId) => {
      const user = findIdentityUser(userId);
      const email = user && "email" in user ? String(user.email ?? "").trim() : "";
      return user ? `${user.name}${email ? ` <${email}>` : "（未维护邮箱）"}` : userId;
    }),
  ].filter(Boolean);
  return recipients.length ? recipients.join("、") : "已启用，未配置收件人";
};

const printableValue = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(printableValue).filter(Boolean).join("、") || "—";
  if (typeof value === "string") return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return value && typeof value === "object" ? "已填写" : "—";
};

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

  const printableFields = version?.snapshot.form.fields.filter((field) => !["attachment", "table"].includes(field.type)) ?? [];
  const tableFields = version?.snapshot.form.fields.filter((field) => field.type === "table") ?? [];
  const attachmentNames = instance.attachmentNames?.length ? instance.attachmentNames : instance.pdfName !== "无附件" ? [instance.pdfName] : [];
  const configuredNodes = version?.snapshot.flow.nodes.filter((node) => node.data?.kind === "approval" || node.data?.kind === "end") ?? [];
  const instanceTasks = tasks.filter((task) => task.instanceId === instance.id);
  const sortedInstanceTasks = [...instanceTasks].sort((left, right) => left.round - right.round || left.createdAt.localeCompare(right.createdAt, "zh-CN") || left.nodeName.localeCompare(right.nodeName, "zh-CN"));
  const modificationRecords = instanceTasks.flatMap((task) => [
    ...(task.submittedFieldChanges?.length ? [{
      key: `${task.id}-submitted`,
      round: task.round,
      nodeName: task.nodeName,
      actor: task.completedByName ?? "—",
      time: task.completedAt ?? "—",
      comment: `随${task.action ?? "处理"}结果提交`,
      changes: task.submittedFieldChanges,
    }] : []),
    ...(task.fieldRevisions ?? []).map((revision) => ({
      key: revision.id,
      round: task.round,
      nodeName: task.nodeName,
      actor: revision.editedByName,
      time: revision.editedAt,
      comment: revision.comment?.trim() || "未填写修改说明",
      changes: revision.changes,
    })),
  ]).sort((left, right) => left.time.localeCompare(right.time, "zh-CN"));

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
            <h1>流程审核记录</h1>
            <p>{instance.title}</p>
          </div>
          <div className="process-print-code">
            <small>流程实例编号</small>
            <strong>{instance.code}</strong>
          </div>
        </header>

        <section className="print-section print-summary-section">
          <h2>一、流程基本信息</h2>
          <dl className="print-summary-grid">
            <div><dt>流程名称</dt><dd>{instance.template}</dd></div>
            <div><dt>流程版本</dt><dd>{instance.templateVersion}</dd></div>
            <div><dt>流程状态</dt><dd><span className={`print-status status-${instance.status}`}>{instance.status}</span></dd></div>
            <div><dt>当前轮次</dt><dd>第 {instance.round} 轮</dd></div>
            <div><dt>发布人</dt><dd>{instance.initiator}（{instance.department}）</dd></div>
            <div><dt>发布时间</dt><dd>{instance.createdAt}</dd></div>
            <div><dt>当前节点</dt><dd>{instance.currentNode}</dd></div>
            <div><dt>最近更新</dt><dd>{instance.updatedAt}</dd></div>
          </dl>
        </section>

        <section className="print-section">
          <h2>二、流程表单</h2>
          <table className="print-form-table">
            <tbody>
              {printableFields.length ? printableFields.map((field) => (
                <tr key={field.id}><th>{field.label}</th><td colSpan={3} className="print-multiline">{printableValue(instance.formValues?.[field.id])}</td></tr>
              )) : (
                <><tr><th>标题</th><td colSpan={3}>{instance.title}</td></tr><tr><th>说明</th><td colSpan={3}>{instance.description}</td></tr></>
              )}
            </tbody>
          </table>
          {tableFields.map((field) => {
            const rows = Array.isArray(instance.formValues?.[field.id]) ? instance.formValues?.[field.id] as Array<Record<string, unknown>> : [];
            return <div key={field.id}><h3>{field.label}</h3><table className="print-data-table"><thead><tr>{field.columns?.map((column) => <th key={column.id}>{column.label}</th>)}</tr></thead><tbody>{rows.length ? rows.map((row, index) => <tr key={String(row.key ?? index)}>{field.columns?.map((column) => <td key={column.id}>{printableValue(row[column.id])}</td>)}</tr>) : <tr><td colSpan={Math.max(field.columns?.length ?? 1, 1)}>—</td></tr>}</tbody></table></div>;
          })}
        </section>

        <section className="print-section">
          <h2>三、附件清单</h2>
          {attachmentNames.length ? attachmentNames.map((name) => <div className="print-file-row" key={name}><FilePdfOutlined /><div><strong>{name}</strong><span>仅列出附件名称，附件正文不随流程打印</span></div></div>) : <p className="print-empty-text">无附件</p>}
        </section>

        <section className="print-section">
          <h2>四、审批进度与审核信息</h2>
          <table className="print-review-table">
            <thead>
              <tr><th>审批节点</th><th>处理方式</th><th>流程权限组</th><th>默认责任人</th><th>实际处理人</th><th>处理结果</th><th>处理时间</th><th>处理说明</th></tr>
            </thead>
            <tbody>
              {sortedInstanceTasks.map((task) => {
                const reviewer = instance.reviewers.find((item) => item.key === task.nodeId && task.round === instance.round);
                const node = version?.snapshot.flow.nodes.find((item) => item.id === task.nodeId);
                const status = taskReviewStatus(task);
                const groupName = workflowGroups.find((group) => group.id === task.permissionGroupId)?.name ?? reviewer?.group ?? task.permissionGroupId;
                const isSubstitute = Boolean(task.completedById && task.defaultAssigneeId && task.completedById !== task.defaultAssigneeId);
                return <tr key={task.id}>
                  <td>第 {task.round} 轮<br />{task.nodeName}</td>
                  <td>{node?.data?.handlingMode === "confirmation" ? "确认" : "审批"}</td>
                  <td>{groupName}</td>
                  <td>{findIdentityUser(task?.defaultAssigneeId ?? "")?.name ?? "组内共享"}</td>
                  <td>{task.completedAt ? <>{task.completedByName ?? "—"}{isSubstitute ? "（代办）" : ""}</> : "—"}</td>
                  <td><span className={`print-review-status ${reviewStatusClass[status]}`}>{status}</span></td>
                  <td>{task.completedAt ?? task.conditionEvaluatedAt ?? "—"}</td>
                  <td className="print-multiline">{task.comment ?? task.conditionSummary ?? "—"}</td>
                </tr>;
              })}
            </tbody>
          </table>
          {configuredNodes.length ? <>
            <h3>节点处理与通知配置</h3>
            <table className="print-data-table">
              <thead><tr><th>节点</th><th>节点类型</th><th>允许重复修改</th><th>邮件通知</th></tr></thead>
              <tbody>{configuredNodes.map((node) => {
                const kind = node.data?.kind ?? "approval";
                return <tr key={`config-${node.id}`}>
                  <td>{node.data?.label || (kind === "end" ? "结束" : "未命名节点")}</td>
                  <td>{kind === "end" ? "结束节点" : node.data?.handlingMode === "confirmation" ? "确认" : "审批"}</td>
                  <td>{kind === "approval" ? node.data?.allowRepeatedEditing ? "允许" : "不允许" : "不适用"}</td>
                  <td className="print-multiline">{emailNotificationText(node.data?.emailNotification)}</td>
                </tr>;
              })}</tbody>
            </table>
          </> : null}
        </section>

        <section className="print-section">
          <h2>五、审核修改记录</h2>
          {modificationRecords.length ? <table className="print-data-table">
            <thead><tr><th>轮次 / 节点</th><th>修改人 / 时间</th><th>修改说明</th><th>字段差异</th></tr></thead>
            <tbody>{modificationRecords.map((record) => <tr key={record.key}>
              <td>第 {record.round} 轮<br />{record.nodeName}</td>
              <td>{record.actor}<br />{record.time}</td>
              <td className="print-multiline">{record.comment}</td>
              <td className="print-multiline">{record.changes.map((change) => `${change.label}：${change.before || "空"} → ${change.after || "空"}`).join("\n")}</td>
            </tr>)}</tbody>
          </table> : <p className="print-empty-text">没有审核字段修改记录。</p>}
        </section>

        <section className="print-section">
          <h2>六、流程流转记录</h2>
          <ol className="print-history-list">
            <li><time>{instance.createdAt}</time><div><strong>第 {instance.round} 轮发起</strong><p>{instance.initiator} 发起流程，附件：{attachmentNames.join("、") || "无"}</p></div></li>
            {sortedInstanceTasks.filter((task) => task.status === "已完成" || task.status === "已跳过").map((task) => {
              const status = taskReviewStatus(task);
              return <li key={`history-${task.id}`}><time>{task.completedAt ?? task.conditionEvaluatedAt}</time><div><strong>第 {task.round} 轮 · {task.nodeName} · {status}</strong><p>{task.status === "已跳过" ? task.conditionSummary ?? "节点条件不满足" : `${task.completedByName ?? "未知处理人"}：${task.comment ?? (task.action === "确认" ? "未填写确认说明" : "未填写审核意见")}`}</p></div></li>;
            })}
            {instance.status === "已完成" && <li><time>{instance.updatedAt}</time><div><strong>流程完成</strong><p>全部前置节点已通过、确认或按条件跳过。</p></div></li>}
            {instance.status === "已关闭" && <li><time>{instance.updatedAt}</time><div><strong>流程关闭</strong><p>授权人员关闭流程，未完成待办已取消。</p></div></li>}
          </ol>
        </section>

        <footer className="process-print-footer">
          <span>打印时间：{new Date().toLocaleString("zh-CN", { hour12: false })}</span>
          <span>此文件由 FlowPilot 流程审核中心生成</span>
        </footer>
      </article>
    </main>
  );
}
