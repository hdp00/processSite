import { ArrowLeftOutlined, FilePdfOutlined, PrinterOutlined } from "@ant-design/icons";
import { Button, Empty, Space, Tag } from "antd";
import { useNavigate, useParams } from "react-router-dom";
import type { ReviewerProgress } from "../data/types";
import { usePrototypeStore } from "../state/usePrototypeStore";

const reviewStatusClass: Record<ReviewerProgress["status"], string> = {
  待审核: "pending",
  已通过: "passed",
  已驳回: "rejected",
  已取消: "cancelled",
};

const detailRows = [
  { clause: "3.2", change: "装配扭矩复检由抽检调整为全检", type: "工艺要求", department: "生产 / 质量", risk: "低" },
  { clause: "5.1", change: "新增关键尺寸记录与签名栏", type: "记录要求", department: "研发 / 质量", risk: "中" },
];

export function ProcessPrintPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const instance = usePrototypeStore((state) => state.instances.find((item) => item.id === id));

  if (!instance || instance.workflowType === "free") {
    return (
      <main className="print-preview-page print-preview-empty">
        <Empty description={instance?.workflowType === "free" ? "自由协作流程不提供 PDF 打印" : "未找到可打印的流程数据"} />
        <Button onClick={() => navigate(-1)}>返回</Button>
      </main>
    );
  }

  const completedReviews = instance.reviewers.filter((reviewer) => reviewer.actionAt);

  return (
    <main className="print-preview-page">
      <div className="print-preview-toolbar no-print">
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => {
            if (window.opener) window.close();
            else navigate(-1);
          }}
        >
          返回
        </Button>
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
              <tr><th>文件标题</th><td colSpan={3}>{instance.title}</td></tr>
              <tr><th>文件编号</th><td>{instance.documentCode}</td><th>文件类型</th><td>{instance.documentType}</td></tr>
              <tr><th>文件密级</th><td>{instance.documentLevel}</td><th>修订版本</th><td>{instance.revision}</td></tr>
              {instance.productModel && (
                <tr><th>产品型号</th><td>{instance.productModel}</td><th>测试类型</th><td>{instance.testType ?? "—"}</td></tr>
              )}
              {instance.testConclusion && <tr><th>测试结论</th><td colSpan={3}>{instance.testConclusion}</td></tr>}
              <tr><th>产品线</th><td colSpan={3}>工业控制 / 驱动器 / {instance.productModel ?? "MTR-320"}</td></tr>
              <tr><th>变更说明</th><td colSpan={3} className="print-multiline">{instance.description}</td></tr>
            </tbody>
          </table>

          <h3>变更明细</h3>
          <table className="print-data-table">
            <thead><tr><th>条款</th><th>变更内容</th><th>变更类型</th><th>涉及部门</th><th>质量风险</th></tr></thead>
            <tbody>
              {detailRows.map((row) => (
                <tr key={row.clause}><td>{row.clause}</td><td>{row.change}</td><td>{row.type}</td><td>{row.department}</td><td>{row.risk}</td></tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="print-section">
          <h2>三、附件清单</h2>
          <div className="print-file-row">
            <FilePdfOutlined />
            <div><strong>{instance.pdfName}</strong><span>{instance.pdfSize} · 仅列出附件名称，附件正文不随流程打印</span></div>
          </div>
        </section>

        <section className="print-section">
          <h2>四、审批进度与审核信息</h2>
          <table className="print-review-table">
            <thead>
              <tr><th>审批节点</th><th>流程权限组</th><th>默认责任人</th><th>实际处理人</th><th>审核结果</th><th>审核时间</th><th>审核意见</th></tr>
            </thead>
            <tbody>
              {instance.reviewers.map((reviewer) => (
                <tr key={reviewer.key}>
                  <td>{reviewer.shortGroup}</td>
                  <td>{reviewer.group}</td>
                  <td>{instance.designatedReviewer ?? reviewer.name}</td>
                  <td>{reviewer.actionAt ? <>{reviewer.name}{reviewer.substitute ? "（代办）" : ""}</> : "—"}</td>
                  <td><span className={`print-review-status ${reviewStatusClass[reviewer.status]}`}>{reviewer.status}</span></td>
                  <td>{reviewer.actionAt ?? "—"}</td>
                  <td className="print-multiline">{reviewer.comment ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="print-section">
          <h2>五、审核修改记录</h2>
          {completedReviews.length ? (
            <table className="print-data-table">
              <thead><tr><th>轮次</th><th>审批节点</th><th>修改人</th><th>修改字段</th><th>修改前</th><th>修改后</th><th>提交结果</th></tr></thead>
              <tbody>
                {completedReviews.map((reviewer) => (
                  <tr key={`change-${reviewer.key}`}>
                    <td>第 {instance.round} 轮</td><td>{reviewer.shortGroup}</td><td>{reviewer.name}</td>
                    <td>{reviewer.key === "qa" ? "文件密级 / 质量风险" : "—"}</td>
                    <td>{reviewer.key === "qa" ? "内部文件 / 中" : "—"}</td>
                    <td>{reviewer.key === "qa" ? `${instance.documentLevel} / 低` : "—"}</td>
                    <td>{reviewer.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="print-empty-text">本轮尚无审核修改记录。</p>}
        </section>

        <section className="print-section">
          <h2>六、流程流转记录</h2>
          <ol className="print-history-list">
            <li><time>{instance.createdAt}</time><div><strong>第 {instance.round} 轮发布</strong><p>{instance.initiator} 发布流程，附件：{instance.pdfName}</p></div></li>
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
