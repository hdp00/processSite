import {
  ArrowLeftOutlined,
  CheckCircleFilled,
  CheckOutlined,
  CloseCircleFilled,
  CloseOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeOutlined,
  FilePdfOutlined,
  HistoryOutlined,
  LockOutlined,
  PrinterOutlined,
  ReloadOutlined,
  SendOutlined,
  StopOutlined,
  TeamOutlined,
  UploadOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Cascader,
  Descriptions,
  Divider,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  Upload,
  message,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { InstanceStatus, ReviewerProgress } from "../data/types";
import { personas, usePrototypeStore } from "../state/usePrototypeStore";

const statusColor: Record<InstanceStatus, string> = {
  审核中: "processing",
  驳回待处理: "error",
  已完成: "success",
  已关闭: "default",
};

const reviewMeta: Record<ReviewerProgress["status"], { color: string; icon: React.ReactNode }> = {
  待审核: { color: "processing", icon: <HistoryOutlined /> },
  已通过: { color: "success", icon: <CheckCircleFilled /> },
  已驳回: { color: "error", icon: <CloseCircleFilled /> },
  已取消: { color: "default", icon: <StopOutlined /> },
};

type PendingAction = "pass" | "reject" | null;

export function ProcessDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const {
    instances,
    personaId,
    reviewInstance,
    closeInstance,
    updateUnreviewedInstance,
    republishInstance,
  } = usePrototypeStore();
  const instance = instances.find((item) => item.id === id);
  const persona = personas.find((item) => item.id === personaId) ?? personas[2];
  const [comment, setComment] = useState("");
  const [documentLevel, setDocumentLevel] = useState(instance?.documentLevel ?? "受控文件");
  const [draftTitle, setDraftTitle] = useState(instance?.title ?? "");
  const [draftDocumentCode, setDraftDocumentCode] = useState(instance?.documentCode ?? "");
  const [draftDocumentType, setDraftDocumentType] = useState(instance?.documentType ?? "");
  const [draftDescription, setDraftDescription] = useState(instance?.description ?? "");
  const [draftPdfName, setDraftPdfName] = useState(instance?.pdfName ?? "");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeReason, setCloseReason] = useState("");

  useEffect(() => {
    if (instance) {
      setDocumentLevel(instance.documentLevel);
      setDraftTitle(instance.title);
      setDraftDocumentCode(instance.documentCode);
      setDraftDocumentType(instance.documentType);
      setDraftDescription(instance.description);
      setDraftPdfName(instance.pdfName);
    }
  }, [instance?.id, instance?.documentLevel]);


  const currentReviewer = useMemo(
    () => instance?.reviewers.find((reviewer) => reviewer.key === persona.reviewerKey),
    [instance, persona.reviewerKey],
  );
  const canReview = Boolean(
    instance?.status === "审核中" && persona.reviewerKey && currentReviewer?.status === "待审核",
  );
  const isSubstitute = Boolean(
    canReview && instance?.designatedReviewer && instance.designatedReviewer !== persona.name,
  );
  const isDcc = personaId === "wangmin";
  const hasReviewAction = Boolean(instance?.reviewers.some(
    (reviewer) => reviewer.status === "已通过" || reviewer.status === "已驳回",
  ));
  const canEditBeforeReview = Boolean(isDcc && instance?.status === "审核中" && !hasReviewAction);
  const canRepublish = isDcc && instance?.status === "驳回待处理";
  const canEditPublishedContent = canEditBeforeReview || canRepublish;

  if (!instance) {
    return (
      <Card className="empty-page-card">
        <Empty description="未找到流程实例" />
        <Button onClick={() => navigate("/processes")}>返回流程清单</Button>
      </Card>
    );
  }

  const openReviewConfirm = (action: Exclude<PendingAction, null>) => {
    if (action === "reject" && !comment.trim()) {
      message.warning("驳回时必须填写审核意见");
      return;
    }
    setPendingAction(action);
  };

  const confirmReview = () => {
    if (!pendingAction) return;
    reviewInstance(instance.id, pendingAction, comment.trim(), documentLevel);
    message.success(pendingAction === "pass" ? "审核已通过" : "已驳回并通知文控处理");
    setPendingAction(null);
    setComment("");
  };

  const confirmClose = () => {
    if (!closeReason.trim()) {
      message.warning("请填写关闭说明");
      return;
    }
    closeInstance(instance.id, closeReason.trim());
    setCloseOpen(false);
    setCloseReason("");
    message.success("流程已关闭，未完成待办已取消");
  };

  const republish = () => {
    if (!draftTitle.trim() || !draftDocumentCode.trim()) {
      message.warning("请完善必填表单内容后再重新发布");
      return;
    }
    Modal.confirm({
      title: `确认重新发布并开启第 ${instance.round + 1} 轮审核？`,
      content: "当前表单修改和可选附件变更将一起发布，全部审批分支都会重新生成待办。",
      okText: "确认重新发布",
      cancelText: "取消",
      icon: <ReloadOutlined />,
      onOk: () => {
        republishInstance(instance.id, {
          title: draftTitle.trim(),
          documentCode: draftDocumentCode.trim(),
          documentType: draftDocumentType,
          documentLevel,
          description: draftDescription.trim(),
          pdfName: draftPdfName,
        });
        message.success("流程已重新发布，全部分支待办已重新生成");
      },
    });
  };

  const saveBeforeReview = () => {
    if (!draftTitle.trim() || !draftDocumentCode.trim()) {
      message.warning("请完善必填表单内容后再保存");
      return;
    }
    updateUnreviewedInstance(instance.id, {
      title: draftTitle.trim(),
      documentCode: draftDocumentCode.trim(),
      documentType: draftDocumentType,
      documentLevel,
      description: draftDescription.trim(),
      pdfName: draftPdfName,
    });
    message.success("修改已保存，本轮待办保持不变");
  };

  const changedLevel = documentLevel !== instance.documentLevel;
  const tableData = [
    { key: "1", clause: "3.2", change: "装配扭矩复检由抽检调整为全检", type: "工艺要求", department: "生产 / 质量", risk: "低" },
    { key: "2", clause: "5.1", change: "新增关键尺寸记录与签名栏", type: "记录要求", department: "研发 / 质量", risk: "中" },
  ];

  return (
    <div className="page-stack detail-page">
      <div className="detail-topbar">
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>返回</Button>
        <div className="detail-topbar-actions">
          <Button icon={<PrinterOutlined />} onClick={() => window.open(`/processes/${instance.id}/print`, "_blank", "noopener,noreferrer")}>打印为 PDF</Button>
          {canEditBeforeReview && (
            <Button type="primary" icon={<EditOutlined />} onClick={saveBeforeReview}>保存修改</Button>
          )}
          {isDcc && instance.status === "驳回待处理" && (
            <Button type="primary" icon={<ReloadOutlined />} onClick={republish}>重新发布</Button>
          )}
          {isDcc && instance.status !== "已关闭" && (
            <Button danger icon={<CloseOutlined />} onClick={() => setCloseOpen(true)}>关闭流程</Button>
          )}
        </div>
      </div>

      <Card className="detail-hero">
        <div className="detail-hero-main">
          <div className="document-icon"><FilePdfOutlined /></div>
          <div>
            <div className="detail-title-row">
              <Typography.Title level={2}>{instance.title}</Typography.Title>
              <Tag color={statusColor[instance.status]}>{instance.status}</Tag>
              {instance.priority === "紧急" && <Tag color="error">紧急</Tag>}
            </div>
            <Space split={<Divider type="vertical" />} wrap>
              <Typography.Text copyable>{instance.code}</Typography.Text>
              <span>{instance.template} · {instance.templateVersion}</span>
              <span>第 {instance.round} 轮</span>
              <span>发起人 {instance.initiator}</span>
              <span>{instance.createdAt}</span>
            </Space>
          </div>
        </div>
        <div className="detail-node-indicator">
          <small>当前节点</small>
          <strong>{instance.currentNode}</strong>
          <span>最近更新 {instance.updatedAt}</span>
        </div>
      </Card>

      {isSubstitute && (
        <Alert
          type="info"
          showIcon
          icon={<TeamOutlined />}
          message={`这是 ${instance.designatedReviewer} 的默认任务，你可以作为同组成员直接代办`}
          description="无需转交或填写代办原因；提交后系统会记录实际处理人为你，并通知默认责任人。"
        />
      )}

      {canRepublish && (
        <Alert
          type="warning"
          showIcon
          message="流程已驳回，发布内容现已解锁"
          description="你可以修改表单，并按需更换附件；确认重新发布后将开启新一轮，全部审批分支重新审核。"
        />
      )}

      {canEditBeforeReview && (
        <Alert
          type="success"
          showIcon
          icon={<EditOutlined />}
          message="本轮尚无人提交审核，发布内容可以修改"
          description="保存修改不会创建新轮次，也不会重新生成待办；任一审批人提交结果后，内容将立即锁定。"
        />
      )}

      {isDcc && instance.status === "审核中" && hasReviewAction && (
        <Alert
          type="info"
          showIcon
          icon={<LockOutlined />}
          message="本轮已有审核结果，发布内容已锁定"
          description="发布方不能再修改表单或附件；如果本轮被驳回，内容会重新开放编辑。"
        />
      )}

      <Card className="progress-card" title="流程进度" extra={<Tag bordered={false}>任一分支驳回，本轮立即结束</Tag>}>
        <div className="parallel-flow">
          <div className="flow-endpoint done"><CheckOutlined /><span>开始<small>{instance.createdAt.slice(5, 16)}</small></span></div>
          <div className="flow-connector"><span /></div>
          <div className="parallel-branch-wrap">
            <div className="parallel-label"><ApartmentBadge />三方并行审核</div>
            <div className="parallel-branches">
              {instance.reviewers.map((reviewer) => (
                <div className={`branch-card status-${reviewer.status}`} key={reviewer.key}>
                  <div className="branch-card-top">
                    <span className="branch-icon">{reviewMeta[reviewer.status].icon}</span>
                    <Tag color={reviewMeta[reviewer.status].color}>{reviewer.status}</Tag>
                  </div>
                  <strong>{reviewer.shortGroup}</strong>
                  <Tooltip title={reviewer.group}><small>{reviewer.group}</small></Tooltip>
                  <div className="branch-person"><UserOutlined /> 默认：{instance.designatedReviewer ?? reviewer.name}</div>
                  {reviewer.actionAt && <div className="branch-action">实际：{reviewer.name}{reviewer.substitute && <Tag color="purple">代办</Tag>}</div>}
                </div>
              ))}
            </div>
          </div>
          <div className="flow-connector"><span /></div>
          <div className={instance.status === "已完成" ? "flow-endpoint done" : "flow-endpoint"}><CheckOutlined /><span>结束<small>{instance.status === "已完成" ? instance.updatedAt.slice(5, 16) : "等待全部通过"}</small></span></div>
        </div>
      </Card>

      <div className="detail-workspace">
        <Card
          className="pdf-card"
          title={<Space><FilePdfOutlined className="pdf-red" />{draftPdfName}<Tag>{instance.pdfSize}</Tag></Space>}
          extra={
            <Space>
              {canEditPublishedContent && (
                <Upload
                  showUploadList={false}
                  beforeUpload={(file) => {
                    setDraftPdfName(file.name);
                    message.success(canRepublish ? "附件已暂存，将在重新发布时一并提交" : "附件已暂存，请保存修改");
                    return false;
                  }}
                >
                  <Button type="text" icon={<UploadOutlined />}>更换附件（可选）</Button>
                </Upload>
              )}
              <Button type="text" icon={<DownloadOutlined />} onClick={() => message.info("原型：已触发受控下载")}>下载</Button>
              <Tag color="success" icon={<EyeOutlined />}>页面内展示</Tag>
            </Space>
          }
        >
          <div className="pdf-viewer-toolbar">
            <span>第 1 / 12 页</span>
            <Space><Button size="small">−</Button><span>92%</span><Button size="small">＋</Button></Space>
          </div>
          <div className="pdf-stage">
            <article className="pdf-sheet">
              <header>
                <div className="pdf-company">MOONS'</div>
                <div><strong>作业指导书</strong><small>WORK INSTRUCTION</small></div>
                <div><small>文件编号</small><strong>{instance.documentCode}</strong></div>
              </header>
              <h1>{instance.title}</h1>
              <div className="pdf-meta-row"><span>版本：{instance.revision}</span><span>生效日期：待审批</span><span>页码：1 / 12</span></div>
              <h2>1. 目的</h2>
              <p>规范 MTR-320 步进电机装配与复检过程，确保关键尺寸及扭矩参数满足设计与质量要求。</p>
              <h2>2. 适用范围</h2>
              <p>适用于工业控制产品线 MTR-320 系列步进电机的装配、过程检验与记录。</p>
              <h2>3. 操作要求</h2>
              <div className="pdf-table">
                <div><b>序号</b><b>工序</b><b>控制要求</b></div>
                <div><span>01</span><span>定子装配</span><span>定位面清洁，无异物残留</span></div>
                <div><span>02</span><span>螺钉锁附</span><span>扭矩 1.8 ± 0.1 N·m，全数复检</span></div>
                <div><span>03</span><span>尺寸确认</span><span>关键尺寸记录并由复检人员签名</span></div>
              </div>
              <div className="pdf-stamp">受控文件 · 审核中</div>
            </article>
          </div>
        </Card>

        <div className="form-review-column">
          <Card
            className="form-card"
            title={<span>流程表单 <Tag bordered={false}>动态表单</Tag></span>}
            extra={canRepublish
              ? <Tag color="orange" icon={<EditOutlined />}>驳回后可修改</Tag>
              : canEditBeforeReview
                ? <Tag color="green" icon={<EditOutlined />}>首人审核前可修改</Tag>
              : canReview
                ? <Tag color="gold" icon={<EditOutlined />}>2 项本节点可修改</Tag>
                : <Tag icon={<LockOutlined />}>只读</Tag>}
          >
            <div className="form-field-grid">
              <label className={canEditPublishedContent ? "field-block editable-field" : "field-block"}><span>文件标题</span><Input value={draftTitle} readOnly={!canEditPublishedContent} onChange={(event) => setDraftTitle(event.target.value)} /></label>
              <label className={canEditPublishedContent ? "field-block editable-field" : "field-block"}><span>文件编号</span><Input value={draftDocumentCode} readOnly={!canEditPublishedContent} onChange={(event) => setDraftDocumentCode(event.target.value)} /></label>
              <label className={canEditPublishedContent ? "field-block editable-field" : "field-block"}><span>文件类型</span><Select value={draftDocumentType} disabled={!canEditPublishedContent} onChange={setDraftDocumentType} options={["作业指导书", "检验规范", "工程变更通知", "测试报告"].map((value) => ({ value }))} /></label>
              <label className={canReview || canEditPublishedContent ? "field-block editable-field" : "field-block"}>
                <span>文件密级 {canReview && <em>本节点可修改</em>}</span>
                <Select
                  value={documentLevel}
                  disabled={!canReview && !canEditPublishedContent}
                  onChange={setDocumentLevel}
                  options={["受控文件", "内部文件", "公开文件"].map((value) => ({ value }))}
                />
              </label>
              <label className="field-block field-wide"><span>产品线</span><Input value="工业控制 / 驱动器 / MTR-320" readOnly /></label>
              <label className={canEditPublishedContent ? "field-block field-wide editable-field" : "field-block field-wide"}><span>变更说明</span><Input.TextArea value={draftDescription} readOnly={!canEditPublishedContent} onChange={(event) => setDraftDescription(event.target.value)} autoSize={{ minRows: 2, maxRows: 4 }} /></label>
            </div>

            <Divider titlePlacement="start">变更明细</Divider>
            <Table
              size="small"
              rowKey="key"
              dataSource={tableData}
              pagination={false}
              scroll={{ x: 680 }}
              columns={[
                { title: "条款", dataIndex: "clause", width: 70 },
                { title: "变更内容", dataIndex: "change", width: 230 },
                { title: "变更类型", dataIndex: "type", width: 110 },
                { title: "涉及部门", dataIndex: "department", width: 120 },
                {
                  title: <span>质量风险 {canReview && <Tag color="gold">可改</Tag>}</span>,
                  dataIndex: "risk",
                  width: 115,
                  render: (value: string) => canReview ? <Select size="small" defaultValue={value} options={["低", "中", "高"].map((item) => ({ value: item }))} /> : value,
                },
              ]}
            />
            <Typography.Text className="table-rule-note" type="secondary">审核人仅可修改已授权单元格，不能新增、删除或复制整行。</Typography.Text>
          </Card>

          {canReview && (
            <Card className="approval-card" title={isSubstitute ? "代办审核" : `${currentReviewer?.shortGroup ?? "节点"}处理`}>
              <label className="field-block">
                <span>审核意见 <em className="required-hint">驳回时必填</em></span>
                <Input.TextArea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="填写审核意见；通过时可选，驳回时必填"
                  autoSize={{ minRows: 3, maxRows: 6 }}
                  maxLength={500}
                  showCount
                />
              </label>
              <div className="approval-actions">
                <Button danger size="large" icon={<CloseOutlined />} onClick={() => openReviewConfirm("reject")}>驳回</Button>
                <Button type="primary" size="large" icon={<CheckOutlined />} onClick={() => openReviewConfirm("pass")}>通过并提交</Button>
              </div>
            </Card>
          )}

          {!canReview && instance.status === "审核中" && (
            !isDcc && <Alert message="当前以只读方式查看" description="你没有此待办的处理权限，或该节点已由其他成员完成。" type="info" showIcon />
          )}
        </div>
      </div>

      <Card title="流转记录" extra={<Tag bordered={false}>按轮次留痕</Tag>}>
        <Timeline
          items={[
            {
              color: "blue",
              children: <HistoryItem title={`第 ${instance.round} 轮发起`} person={`${instance.initiator} · ${instance.department}`} time={instance.createdAt} detail={`上传 ${instance.pdfName}`} />,
            },
            ...instance.reviewers
              .filter((reviewer) => reviewer.actionAt)
              .map((reviewer) => ({
                color: reviewer.status === "已通过" ? "green" : "red",
                children: <HistoryItem title={`${reviewer.shortGroup} · ${reviewer.status}`} person={`实际处理人 ${reviewer.name}${reviewer.substitute ? "（代办）" : ""}`} time={reviewer.actionAt ?? ""} detail={reviewer.comment ?? "未填写意见"} />,
              })),
          ]}
        />
      </Card>

      <Modal
        open={Boolean(pendingAction)}
        title={pendingAction === "pass" ? "确认通过本节点？" : "确认驳回本轮审核？"}
        okText={pendingAction === "pass" ? "确认通过" : "确认驳回"}
        okButtonProps={{ danger: pendingAction === "reject" }}
        cancelText="返回检查"
        onOk={confirmReview}
        onCancel={() => setPendingAction(null)}
      >
        <div className="confirm-summary">
          <p>{pendingAction === "pass" ? "审核结果和表单修改将一次性提交。" : "其他未完成的并行任务会立即取消，并通知文控重新处理。"}</p>
          {changedLevel && <div><span>文件密级</span><del>{instance.documentLevel}</del><b>→</b><ins>{documentLevel}</ins></div>}
          <div><span>审核意见</span><strong>{comment.trim() || "未填写（通过时允许）"}</strong></div>
          {isSubstitute && <Tag color="purple">将记录为代办：默认 {instance.designatedReviewer} / 实际 {persona.name}</Tag>}
        </div>
      </Modal>

      <Modal open={closeOpen} title="关闭流程" okText="确认关闭" okButtonProps={{ danger: true }} cancelText="取消" onOk={confirmClose} onCancel={() => setCloseOpen(false)}>
        <Alert type="warning" showIcon message="关闭后不可恢复，所有未完成待办将被取消。" />
        <label className="field-block modal-field"><span>关闭说明 <em className="required-hint">必填</em></span><Input.TextArea value={closeReason} onChange={(event) => setCloseReason(event.target.value)} placeholder="请说明关闭原因" rows={3} /></label>
      </Modal>
    </div>
  );
}

function ApartmentBadge() {
  return <span className="parallel-badge"><TeamOutlined /></span>;
}

function HistoryItem({ title, person, time, detail }: { title: string; person: string; time: string; detail: string }) {
  return (
    <div className="history-item">
      <div><strong>{title}</strong><span>{time}</span></div>
      <small>{person}</small>
      <p>{detail}</p>
    </div>
  );
}
