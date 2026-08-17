import {
  ExperimentOutlined,
  FilePdfOutlined,
  MessageOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { Button, Card, Empty, Space, Tag, Typography } from "antd";
import { useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { canPersonaLaunchDefinition } from "../state/rolePermissions";
import { getEffectiveVersion, useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { usePrototypeStore } from "../state/usePrototypeStore";
import "./launch-pages.css";

interface LaunchDefinition {
  id: string;
  name: string;
  description: string;
  categoryLabel: string;
  version: string;
  permissionGroups: string[];
  icon: ReactNode;
  tone: "blue" | "cyan" | "purple" | "amber";
  route: string;
}

const launchDefinitions: LaunchDefinition[] = [
  {
    id: "pdf-review",
    name: "PDF审核",
    description: "上传受控 PDF 文件，由研发、质量、生产三个流程权限组并行审核。",
    categoryLabel: "固定审批",
    version: "V3",
    permissionGroups: ["PDF审核_发起权限组"],
    icon: <FilePdfOutlined />,
    tone: "blue",
    route: "/launch/pdf-review",
  },
  {
    id: "test-report-review",
    name: "测试报告审核",
    description: "提交测试结论和验证明细，适用于产品验证及例行测试报告。",
    categoryLabel: "固定审批",
    version: "V1",
    permissionGroups: ["测试报告_发起权限组"],
    icon: <ExperimentOutlined />,
    tone: "cyan",
    route: "/launch/test-report-review",
  },
  {
    id: "free-collaboration",
    name: "自由协作",
    description: "创建协作事项并选择首位受理人，后续可持续回复、流转和手动关闭。",
    categoryLabel: "自由流程",
    version: "V2",
    permissionGroups: ["自由协作_发起权限组"],
    icon: <MessageOutlined />,
    tone: "purple",
    route: "/free-flow/new",
  },
  {
    id: "engineering-change",
    name: "工程变更审批",
    description: "用于产品设计、物料和工艺变更的跨部门评审。",
    categoryLabel: "固定审批",
    version: "V1",
    permissionGroups: ["工程变更_发起权限组"],
    icon: <SafetyCertificateOutlined />,
    tone: "amber",
    route: "/launch/engineering-change",
  },
];

export function ProcessLaunchCenterPage() {
  const navigate = useNavigate();
  const personaId = usePrototypeStore((state) => state.personaId);
  const managedDefinitions = useProcessDefinitionStore((state) => state.definitions);
  const availableDefinitions = useMemo(
    () => managedDefinitions.flatMap((managed, index) => {
      const effective = getEffectiveVersion(managed);
      if (managed.disabled || !effective) return [];
      const preset = launchDefinitions.find((item) => item.id === managed.id);
      const allowed = canPersonaLaunchDefinition(personaId, managed.id);
      if (!allowed) return [];
      return [{
        id: managed.id,
        name: effective.basic.name,
        description: effective.basic.description,
        categoryLabel: managed.type === "approval" ? "固定审批" : "自由流程",
        version: effective.version,
        permissionGroups: effective.basic.starterGroups,
        icon: preset?.icon ?? (managed.type === "approval" ? <SafetyCertificateOutlined /> : <MessageOutlined />),
        tone: preset?.tone ?? (["blue", "cyan", "purple", "amber"] as const)[index % 4],
        route: `/launch/${managed.id}`,
      }];
    }),
    [managedDefinitions, personaId],
  );

  return (
    <div className="page-stack launch-center-page">
      <Card className="launch-overview-card">
        <div className="launch-overview-copy">
          <span className="launch-overview-icon"><SafetyCertificateOutlined /></span>
          <div>
            <Typography.Title level={3}>选择要发起的流程</Typography.Title>
            <Typography.Text type="secondary">
              这里只展示已发布流程；发起权限由流程权限组实时决定。
            </Typography.Text>
          </div>
        </div>
        <div className="launch-overview-count" aria-label={`${availableDefinitions.length} 个可发起流程`}>
          <strong>{availableDefinitions.length}</strong>
          <span>个可发起流程</span>
        </div>
      </Card>

      {availableDefinitions.length > 0 ? (
        <section className="launch-definition-grid" aria-label="可发起流程列表">
          {availableDefinitions.map((definition) => (
            <Card
              key={definition.id}
              className={`launch-definition-card tone-${definition.tone}`}
              hoverable
              onClick={() => navigate(definition.route)}
            >
              <div className="launch-card-head">
                <span className="launch-card-icon">{definition.icon}</span>
                <Space size={6} wrap>
                  <Tag bordered={false}>{definition.categoryLabel}</Tag>
                  <Tag bordered={false} className="launch-version-tag">{definition.version}</Tag>
                </Space>
              </div>
              <div className="launch-card-copy">
                <Typography.Title level={4}>{definition.name}</Typography.Title>
                <Typography.Paragraph>{definition.description}</Typography.Paragraph>
              </div>
              <div className="launch-card-meta">
                <span><TeamOutlined /><span>发起权限组</span><strong>{definition.permissionGroups.join("、")}</strong></span>
              </div>
              <div className="launch-card-foot">
                <Button
                  type="primary"
                  icon={<RightOutlined />}
                  iconPosition="end"
                  aria-label={`发起${definition.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    navigate(definition.route);
                  }}
                >
                  立即发起
                </Button>
              </div>
            </Card>
          ))}
        </section>
      ) : (
        <Card className="content-card launch-empty-card">
          <Empty description="没有符合条件的已发布流程" />
        </Card>
      )}
    </div>
  );
}
