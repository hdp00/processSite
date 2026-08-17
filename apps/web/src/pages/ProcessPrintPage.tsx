import { FilePdfOutlined, PrinterOutlined } from "@ant-design/icons";
import { Button, Empty, Space, Tag } from "antd";
import { useNavigate, useParams } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import type { ReviewerProgress } from "../data/types";
import { usePrototypeStore } from "../state/usePrototypeStore";
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { findIdentityUser } from "../state/useIdentityStore";

const reviewStatusClass: Record<ReviewerProgress["status"], string> = {
  待审核: "pending",
  已通过: "passed",
  已驳回: "rejected",
  已取消: "cancelled",
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

  const completedReviews = instance.reviewers.filter((reviewer) => reviewer.actionAt);
  const printableFields = version?.snapshot.form.fields.filter((field) => !["attachment", "table"].includes(field.type)) ?? [];
  const tableFields = version?.snapshot.form.fields.filter((field) => field.type === "table") ?? [];
  const attachmentNames = instance.attachmentNames?.length ? instance.attachmentNames : instance.pdfName !== "无附件" ? [instance.pdfName] : [];

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
              <tr><th>审批节点</th><th>流程权限组</th><th>默认责任人</th><th>实际处理人</th><th>审核结果</th><th>审核时间</th><th>审核意见</th></tr>
            </thead>
            <tbody>
              {instance.reviewers.map((reviewer) => {
                const task = tasks.find((item) => item.instanceId === instance.id && item.nodeId === reviewer.key && item.round === instance.round);
                return <tr key={reviewer.key}>
                  <td>{reviewer.shortGroup}</td>
                  <td>{reviewer.group}</td>
                  <td>{findIdentityUser(task?.defaultAssigneeId ?? "")?.name ?? "组内共享"}</td>
                  <td>{reviewer.actionAt ? <>{reviewer.name}{reviewer.substitute ? "（代办）" : ""}</> : "—"}</td>
                  <td><span className={`print-review-status ${reviewStatusClass[reviewer.status]}`}>{reviewer.status}</span></td>
                  <td>{reviewer.actionAt ?? "—"}</td>
                  <td className="print-multiline">{reviewer.comment ?? "—"}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </section>

        <section className="print-section">
          <h2>五、审核修改记录</h2>
          <p className="print-empty-text">本轮没有提交字段修改；审核结果与意见见上表。</p>
        </section>

        <section className="print-section">
          <h2>六、流程流转记录</h2>
          <ol className="print-history-list">
            <li><time>{instance.createdAt}</time><div><strong>第 {instance.round} 轮发起</strong><p>{instance.initiator} 发起流程，附件：{attachmentNames.join("、") || "无"}</p></div></li>
            {completedReviews.map((reviewer) => (
              <li key={`history-${reviewer.key}`}><time>{reviewer.actionAt}</time><div><strong>{reviewer.shortGroup} · {reviewer.status}</strong><p>{reviewer.name}{reviewer.substitute ? "（代办）" : ""}：{reviewer.comment ?? "未填写审核意见"}</p></div></li>
            ))}
            {instance.status === "已完成" && <li><time>{instance.updatedAt}</time><div><strong>流程完成</strong><p>全部审批节点已通过。</p></div></li>}
            {instance.status === "已关闭" && <li><time>{instance.updatedAt}</time><div><strong>流程关闭</strong><p>发布方关闭流程，未完成待办已取消。</p></div></li>}
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
