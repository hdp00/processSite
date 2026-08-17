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
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import { ProcessWizardNextButton } from "../components/ProcessWizardNavigation";
import { ProcessWizardSteps } from "../components/ProcessWizardSteps";
import { StatusPill } from "../components/StatusPill";
import { useUnsavedChangesGuard } from "../components/UnsavedChangesGuard";
import { useIdentityStore } from "../state/useIdentityStore";
import {
  canEditVersion,
  getVersionStatus,
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
  const isNew = resolvedId === "new";
  const identityUsers = useIdentityStore((state) => state.users);
  const workflowGroups = useIdentityStore((state) => state.workflowGroups);
  const userOptions = useMemo(() => identityUsers
    .filter((user) => user.status === "启用" && !user.builtIn)
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
    .map((user) => ({
      value: user.id,
      label: `${user.name} · ${user.departmentPath} · ${user.jobTitle}`,
    })), [identityUsers]);
  const starterGroupOptions = workflowGroups
    .filter((group) => group.status === "启用" && group.purposes.includes("发起"))
    .map((group) => ({ value: group.id, label: group.name }));
  const assigneeGroupOptions = workflowGroups
    .filter((group) => group.status === "启用" && group.purposes.includes("自由流程受理"))
    .map((group) => ({ value: group.id, label: group.name }));
  const versionId = searchParams.get("versionId") ?? definition?.versions[0]?.id ?? "";
  const version = definition?.versions.find((item) => item.id === versionId);
  const createDefinition = useProcessDefinitionStore((state) => state.createDefinition);
  const updateVersionBasic = useProcessDefinitionStore((state) => state.updateVersionBasic);
  const initialConfig = useMemo<BasicConfigValues>(() => version?.basic ?? ({
    name: definition?.name ?? searchParams.get("name") ?? "",
    code: definition?.code ?? "保存后自动生成",
    instancePrefix: "",
    type: definition?.type ?? (searchParams.get("type") === "free" ? "free" : "approval"),
    description: definition?.description ?? searchParams.get("description") ?? "",
    starterGroups: [],
    visibleRoles: [],
    visibleUsers: [],
  }), [definition?.code, definition?.description, definition?.name, definition?.type, searchParams, version?.basic]);
  const [form] = Form.useForm<BasicConfigValues>();
  const [lastSavedAt, setLastSavedAt] = useState("2026-08-13 10:32");
  const [dirty, setDirty] = useState(false);
  const workflowType = Form.useWatch("type", form) ?? initialConfig.type;
  const instancePrefix = Form.useWatch("instancePrefix", form) ?? initialConfig.instancePrefix;
  const currentStatus = definition && version ? getVersionStatus(definition, version.id) : "校验未通过";

  useEffect(() => {
    form.setFieldsValue(initialConfig);
  }, [form, initialConfig]);

  const saveVersion = async (navigateToCreated = true) => {
    const values = await form.validateFields();
    if (isNew) {
      const createdId = createDefinition({ name: values.name, type: values.type, description: values.description });
      const createdVersion = useProcessDefinitionStore.getState().definitions.find((item) => item.id === createdId)?.versions[0];
      if (!createdVersion || !updateVersionBasic(createdId, createdVersion.id, { ...values, code: createdVersion.basic.code })) {
        message.error("流程定义创建失败");
        return null;
      }
      setDirty(false);
      setLastSavedAt("刚刚");
      message.success("流程定义已保存，并生成正式 V1");
      if (navigateToCreated) {
        allowNextNavigation();
        navigate(`/admin/processes/${createdId}/basic?versionId=${createdVersion.id}`, { replace: true });
      }
      return { definitionId: createdId, versionId: createdVersion.id };
    }
    const saved = updateVersionBasic(resolvedId, versionId, values);
    if (!saved) {
      message.error("该版本当前不可编辑，请返回版本记录确认状态");
      return null;
    }
    setDirty(false);
    setLastSavedAt("刚刚");
    message.success("版本基本信息已保存，并已自动更新校验结果");
    return { definitionId: resolvedId, versionId };
  };

  const { guard, allowNextNavigation } = useUnsavedChangesGuard({
    dirty,
    onSave: async () => Boolean(await saveVersion(false)),
    title: "基本信息尚未保存",
    description: "可以先保存当前版本再离开，也可以放弃本次修改。",
  });

  const goNext = async () => {
    const saved = await saveVersion(false);
    if (saved) {
      allowNextNavigation();
      navigate(`/admin/processes/${saved.definitionId}/form?versionId=${saved.versionId}`);
    }
  };

  if ((!definition || !version) && !isNew) {
    return <Alert type="error" showIcon message="流程版本不存在" description="请返回流程管理重新选择。" action={<AppBackButton onClick={() => navigate("/admin/processes")} />} />;
  }

  if (definition && version && !canEditVersion(definition, version)) {
    return <Alert type="info" showIcon message={`${version.version} 为只读版本`} description={definition.publishedVersionId === version.id ? "已发布版本不能直接修改。没有实例时可先取消发布；已有实例时请复制新建版本。" : "该版本已有流程实例，只能查看或复制新建版本。"} action={<AppBackButton onClick={() => navigate(`/admin/processes/${resolvedId}/versions`)} />} />;
  }

  return (
    <div className="page-stack pa-page pa-config-page">
      <Card className="pa-config-head" bordered={false}>
        <div className="pa-config-head__main">
          <AppBackButton onClick={() => navigate("/admin/processes")} />
          <div>
            <Space size={10} wrap>
              <Typography.Title level={3}>{initialConfig.name}</Typography.Title>
              <StatusPill status={currentStatus} />
              <Tag color="blue">{isNew ? "首次保存后生成 V1" : `正式版本 ${version?.version}`}</Tag>
              {version?.basedOn && <Tag bordered={false}>来源 {version.basedOn}</Tag>}
            </Space>
            <Typography.Text type="secondary">配置流程身份、实例编号前缀、发起范围和额外查看范围。</Typography.Text>
          </div>
        </div>
        <div className="pa-config-head__actions">
          <div className="pa-save-state">
            <CheckCircleFilled />
            <span>{isNew ? "尚未保存 · 保存后创建 V1" : dirty ? "有未保存修改" : `已保存 · ${lastSavedAt}`}</span>
          </div>
          <Button icon={<SaveOutlined />} onClick={() => void saveVersion()}>保存</Button>
          <ProcessWizardNextButton step="初始表单" onClick={() => void goNext()} />
        </div>
      </Card>

      <Card className="pa-steps-card" bordered={false}>
        <ProcessWizardSteps workflowType={workflowType} current={0} />
      </Card>

      <Form<BasicConfigValues>
        key={version?.id ?? "new-definition"}
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
                      options={starterGroupOptions}
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
                        options={assigneeGroupOptions}
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
                  <li>未发布且没有实例的版本可直接编辑；已有实例后只能复制新建版本。</li>
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
      {guard}
    </div>
  );
}

export default ProcessBasicConfigPage;
