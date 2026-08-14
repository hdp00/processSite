import {
  CheckCircleFilled,
  FileTextOutlined,
  InfoCircleOutlined,
  LockOutlined,
  SaveOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  Row,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import { ProcessWizardNextButton } from "../components/ProcessWizardNavigation";
import { ProcessWizardSteps } from "../components/ProcessWizardSteps";
import { StatusPill } from "../components/StatusPill";
import { workflowPermissionGroupOptions } from "../data/workflowPermissionGroups";
import {
  definitionStatus,
  getEffectiveVersion,
  useProcessDefinitionStore,
  type DefinitionType,
  type ProcessBasicConfig,
} from "../state/useProcessDefinitionStore";
import { formatInstanceNumber } from "../utils/instanceNumber";
import "./process-admin-pages.css";

interface ProcessBasicConfigPageProps {
  definitionId?: string;
}

type BasicConfigValues = ProcessBasicConfig;

const roleOptions = ["系统管理员", "文控专员", "研发经理", "质量经理", "生产经理", "部门查看员"]
  .map((value) => ({ value, label: value }));

const userOptions = [
  ["wangmin", "王敏", "研发 / 软件", "经理"],
  ["zhangwei", "张伟", "研发 / 软件", "员工"],
  ["linxiao", "林晓", "质量", "经理"],
  ["zhaolei", "赵磊", "生产 / 装配", "员工"],
  ["liuyan", "刘燕", "文控", "员工"],
  ["chenjie", "陈杰", "研发 / 硬件", "员工"],
].map(([value, name, department, position]) => ({
  value,
  label: `${name} · ${department} · ${position}`,
}));

export function ProcessBasicConfigPage({ definitionId }: ProcessBasicConfigPageProps) {
  const navigate = useNavigate();
  const params = useParams<{ definitionId?: string; id?: string }>();
  const [searchParams] = useSearchParams();
  const resolvedId = definitionId
    ?? params.definitionId
    ?? params.id
    ?? searchParams.get("definitionId")
    ?? "";
  const definition = useProcessDefinitionStore((state) => state.definitions.find((item) => item.id === resolvedId));
  const ensureDraft = useProcessDefinitionStore((state) => state.ensureDraft);
  const updateDraftBasic = useProcessDefinitionStore((state) => state.updateDraftBasic);
  const effectiveVersion = getEffectiveVersion(definition);
  const publishedBasic = effectiveVersion?.basic;
  const initialConfig = definition?.draft?.basic ?? publishedBasic ?? {
    name: definition?.name ?? "流程不存在",
    code: definition?.code ?? "—",
    instancePrefix: "",
    type: definition?.type ?? "approval",
    description: definition?.description ?? "",
    starterGroups: [],
    visibleRoles: [],
    visibleUsers: [],
  };
  const [form] = Form.useForm<BasicConfigValues>();
  const [lastSavedAt, setLastSavedAt] = useState("2026-08-13 10:32");
  const [dirty, setDirty] = useState(false);
  const workflowType = Form.useWatch("type", form) ?? initialConfig.type;
  const instancePrefix = Form.useWatch("instancePrefix", form) ?? initialConfig.instancePrefix;
  const currentStatus = definition ? definitionStatus(definition) : "草稿";
  const isPublishedSource = Boolean(definition?.draft?.basedOn);
  const isWithdrawnDraft = Boolean(definition?.draft?.withdrawnVersionId);

  useEffect(() => {
    if (definition && !definition.draft) ensureDraft(resolvedId);
  }, [definition, ensureDraft, resolvedId]);

  const saveDraft = async () => {
    const values = await form.validateFields();
    updateDraftBasic(resolvedId, values);
    setDirty(false);
    setLastSavedAt("刚刚");
    message.success(isWithdrawnDraft
      ? `已保存到 ${definition?.draft?.version} 撤回草稿，重新发布后版本号保持不变`
      : isPublishedSource
        ? "已基于已发布版本保存为新草稿"
        : "流程基本信息已保存");
  };

  const goNext = async () => {
    await saveDraft();
    navigate(`/admin/processes/${resolvedId}/form`);
  };

  return (
    <div className="page-stack pa-page pa-config-page">
      <Card className="pa-config-head" bordered={false}>
        <div className="pa-config-head__main">
          <AppBackButton onClick={() => navigate("/admin/processes")} />
          <div>
            <Space size={10} wrap>
              <Typography.Title level={3}>{initialConfig.name}</Typography.Title>
              <StatusPill status={currentStatus} />
              {isPublishedSource && <Tag color="blue">{isWithdrawnDraft ? `${definition?.draft?.version} 撤回编辑` : `基于 ${definition?.draft?.basedOn} 修改`}</Tag>}
              {definition?.effectiveVersionId && definition.draft && <StatusPill status="草稿" label={`${definition.draft.version} 草稿`} />}
            </Space>
            <Typography.Text type="secondary">配置流程身份、实例编号前缀、发起范围和额外查看范围。</Typography.Text>
          </div>
        </div>
        <div className="pa-config-head__actions">
          <div className="pa-save-state">
            <CheckCircleFilled />
            <span>{dirty ? "有未保存修改" : `已保存 · ${lastSavedAt}`}</span>
          </div>
          <Button icon={<SaveOutlined />} onClick={() => void saveDraft()}>保存草稿</Button>
          <ProcessWizardNextButton step="初始表单" onClick={() => void goNext()} />
        </div>
      </Card>

      <Card className="pa-steps-card" bordered={false}>
        <ProcessWizardSteps workflowType={workflowType} current={0} />
      </Card>

      {isPublishedSource && (
        <Alert
          className="pa-page-alert"
          type="info"
          showIcon
          message={isWithdrawnDraft ? `${definition?.draft?.version} 已撤回发布` : "已发布版本保持只读"}
          description={isWithdrawnDraft
            ? "该版本没有关联实例，已按原版本号恢复为草稿。编辑期间流程暂停发起，重新发布后版本号保持不变。"
            : "本次修改会保存为独立草稿；只有再次发布后才会影响新发起的流程，运行中实例继续使用原版本。"}
        />
      )}

      <Form<BasicConfigValues>
        key={definition?.draft?.id ?? resolvedId}
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={initialConfig}
        onValuesChange={() => setDirty(true)}
      >
        <div className="pa-config-grid">
          <div className="pa-config-main">
            <Card
              className="pa-section-card"
              title={<span className="pa-card-title"><FileTextOutlined /> 流程信息</span>}
            >
              <Row gutter={20}>
                <Col span={14}>
                  <Form.Item name="name" label="流程名称" rules={[{ required: true, message: "请输入流程名称" }, { max: 60 }]}>
                    <Input placeholder="请输入便于员工识别的流程名称" maxLength={60} showCount />
                  </Form.Item>
                </Col>
                <Col span={10}>
                  <Form.Item name="code" label="流程编号">
                    <Input readOnly prefix={<LockOutlined />} className="pa-readonly-input" />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={20}>
                <Col span={8}>
                  <Form.Item name="type" label="流程类型" rules={[{ required: true }]} extra="流程类型在新建时确定，创建后不可修改。">
                    <Select<DefinitionType>
                      disabled
                      options={[
                        { value: "approval", label: "固定审批" },
                        { value: "free", label: "自由协作" },
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item
                    name="instancePrefix"
                    label="实例编号前缀"
                    extra="允许不同流程使用同一前缀，并共享该前缀的月度流水号。"
                    rules={[
                      { required: true, whitespace: true, message: "请输入实例编号前缀" },
                      { pattern: /^[A-Za-z0-9_-]+$/, message: "前缀仅支持英文字母、数字、横线和下划线" },
                      { max: 12, message: "前缀最多12个字符" },
                    ]}
                  >
                    <Input placeholder="例如：DOC、PDF-A 或 QA_FLOW" maxLength={12} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="编号格式预览" extra="两位年份 + 两位月份 + 四位月序号，不插入分隔符。">
                    <Input
                      readOnly
                      prefix={<LockOutlined />}
                      className="pa-readonly-input"
                      value={instancePrefix?.trim() ? formatInstanceNumber(instancePrefix, 1) : "前缀YYMM0001"}
                    />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item name="description" label="流程说明" rules={[{ max: 500 }]}>
                <Input.TextArea rows={4} placeholder="说明流程用途、适用范围和注意事项" maxLength={500} showCount />
              </Form.Item>
            </Card>

            <Card
              className="pa-section-card"
              title={<span className="pa-card-title"><TeamOutlined /> 操作权限范围</span>}
              extra={<Tag bordered={false}>人员变更立即生效</Tag>}
            >
              <Alert
                className="pa-section-alert"
                type="info"
                showIcon
                message="流程权限组决定谁可以执行操作"
                description="权限组可直接加入人员，也可关联角色。组内任意一位符合条件的成员完成操作，即视为该节点完成。"
              />
              <Row gutter={20}>
                <Col span={workflowType === "free" ? 12 : 24}>
                  <Form.Item
                    name="starterGroups"
                    label="发起流程权限组（可多选）"
                    rules={[{ required: true, type: "array", min: 1, message: "请至少选择一个发起流程权限组" }]}
                    extra="任一所选权限组的有效成员均可发起和关闭该流程。"
                  >
                    <Select
                      mode="multiple"
                      showSearch
                      optionFilterProp="label"
                      maxTagCount="responsive"
                      placeholder="搜索并选择一个或多个流程权限组"
                      options={workflowPermissionGroupOptions}
                    />
                  </Form.Item>
                </Col>
                {workflowType === "free" && (
                  <Col span={12}>
                    <Form.Item
                      name="assigneeGroups"
                      label="可选受理人流程权限组（可多选）"
                      rules={[{ required: true, type: "array", min: 1, message: "请至少选择一个受理权限组" }]}
                      extra="发起和每次流转时，只能从所选权限组当前有效成员的并集中选择。"
                    >
                      <Select
                        mode="multiple"
                        showSearch
                        optionFilterProp="label"
                        maxTagCount="responsive"
                        placeholder="搜索并选择一个或多个流程权限组"
                        options={workflowPermissionGroupOptions}
                      />
                    </Form.Item>
                  </Col>
                )}
              </Row>
            </Card>

            <Card
              className="pa-section-card"
              title={<span className="pa-card-title"><SafetyCertificateOutlined /> 额外可见范围</span>}
            >
              <Typography.Paragraph type="secondary" className="pa-card-intro">
                发起人、当前处理人和所属流程权限组成员已按规则可见。这里仅补充无需操作、但需要查看流程的人员。
              </Typography.Paragraph>
              <Row gutter={20}>
                <Col span={12}>
                  <Form.Item name="visibleRoles" label="额外可见角色">
                    <Select
                      mode="multiple"
                      showSearch
                      optionFilterProp="label"
                      maxTagCount="responsive"
                      placeholder="可选择多个角色"
                      options={roleOptions}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="visibleUsers" label="额外可见用户" extra="支持按姓名、部门搜索；生产环境由后端分页加载。">
                    <Select
                      mode="multiple"
                      showSearch
                      optionFilterProp="label"
                      maxTagCount="responsive"
                      placeholder="搜索并选择用户"
                      options={userOptions}
                    />
                  </Form.Item>
                </Col>
              </Row>
            </Card>
          </div>

          <aside className="pa-config-aside">
            <Card className="pa-help-card" bordered={false}>
              <div className="pa-help-card__icon"><InfoCircleOutlined /></div>
              <Typography.Title level={5}>当前配置说明</Typography.Title>
              {workflowType === "approval" ? (
                <ul>
                  <li>表单字段和列表字段在下一步配置。</li>
                  <li>审批人、可修改字段和并行关系在流程设计器配置。</li>
                  <li>{isWithdrawnDraft ? "当前版本已撤回，重新发布后版本号保持不变。" : "已有实例的已发布版本修改时会生成下一版本草稿。"}</li>
                </ul>
              ) : (
                <ul>
                  <li>初始表单和列表字段在下一步配置。</li>
                  <li>自由协作不使用节点设计器。</li>
                  <li>受理人处理后继续指定下一位受理人。</li>
                  <li>流程需要手动关闭，并允许填写理由后重新打开。</li>
                </ul>
              )}
            </Card>
            <Card className="pa-scope-card" title="可见范围预览">
              <div className="pa-scope-line"><span>默认可见</span><strong>发起与处理相关人员</strong></div>
              <div className="pa-scope-line"><span>可代办</span><strong>当前流程权限组成员</strong></div>
              <div className="pa-scope-line"><span>额外查看</span><strong>所选角色与用户</strong></div>
            </Card>
          </aside>
        </div>
      </Form>

    </div>
  );
}

export default ProcessBasicConfigPage;
