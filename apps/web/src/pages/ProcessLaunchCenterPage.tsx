import {
  CheckCircleFilled,
  ClockCircleOutlined,
  ExperimentOutlined,
  FilePdfOutlined,
  LockOutlined,
  MessageOutlined,
  RightOutlined,
  SearchOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { Button, Card, Checkbox, Empty, Input, Select, Space, Tag, Tooltip, Typography } from "antd";
import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { canPersonaLaunchDefinition } from "../state/rolePermissions";
import { usePrototypeStore } from "../state/usePrototypeStore";
import "./launch-pages.css";

type LaunchCategory = "approval" | "free";

interface LaunchDefinition {
  id: string;
  name: string;
  description: string;
  category: LaunchCategory;
  categoryLabel: string;
  version: string;
  permissionGroup: string;
  updatedAt: string;
  icon: ReactNode;
  tone: "blue" | "cyan" | "purple" | "amber";
  route: string;
  canLaunch: boolean;
  unavailableReason?: string;
}

const launchDefinitions: LaunchDefinition[] = [
  {
    id: "pdf-review",
    name: "PDF审核",
    description: "上传受控 PDF 文件，由研发、质量、生产三个流程权限组并行审核。",
    category: "approval",
    categoryLabel: "固定审批",
    version: "V2.3",
    permissionGroup: "PDF审核_发起权限组",
    updatedAt: "2026-08-09 16:20",
    icon: <FilePdfOutlined />,
    tone: "blue",
    route: "/launch/pdf-review",
    canLaunch: true,
  },
  {
    id: "test-report-review",
    name: "测试报告审核",
    description: "提交测试结论和验证明细，适用于产品验证及例行测试报告。",
    category: "approval",
    categoryLabel: "固定审批",
    version: "V1.6",
    permissionGroup: "测试报告_发起权限组",
    updatedAt: "2026-08-07 10:45",
    icon: <ExperimentOutlined />,
    tone: "cyan",
    route: "/launch/test-report-review",
    canLaunch: true,
  },
  {
    id: "free-collaboration",
    name: "自由协作",
    description: "创建协作事项并选择首位受理人，后续可持续回复、流转和手动关闭。",
    category: "free",
    categoryLabel: "自由流程",
    version: "V1.0",
    permissionGroup: "自由协作_发起权限组",
    updatedAt: "2026-08-05 14:12",
    icon: <MessageOutlined />,
    tone: "purple",
    route: "/free-flow/new",
    canLaunch: true,
  },
  {
    id: "engineering-change",
    name: "工程变更审批",
    description: "用于产品设计、物料和工艺变更的跨部门评审。",
    category: "approval",
    categoryLabel: "固定审批",
    version: "V1.2",
    permissionGroup: "工程变更_发起权限组",
    updatedAt: "2026-08-03 09:30",
    icon: <SafetyCertificateOutlined />,
    tone: "amber",
    route: "/launch/engineering-change",
    canLaunch: false,
    unavailableReason: "当前账号不在“工程变更_发起权限组”中",
  },
];

export function ProcessLaunchCenterPage() {
  const navigate = useNavigate();
  const personaId = usePrototypeStore((state) => state.personaId);
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState<"all" | LaunchCategory>("all");
  const [availableOnly, setAvailableOnly] = useState(false);

  const permissionDefinitions = useMemo(() => launchDefinitions.map((definition) => ({
    ...definition,
    canLaunch: canPersonaLaunchDefinition(personaId, definition.id),
    unavailableReason: `当前账号不在“${definition.permissionGroup}”中`,
  })), [personaId]);

  const filteredDefinitions = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return permissionDefinitions.filter((definition) => {
      const matchesKeyword = `${definition.name}${definition.description}${definition.permissionGroup}`
        .toLowerCase()
        .includes(normalizedKeyword);
      const matchesCategory = category === "all" || definition.category === category;
      const matchesAvailability = !availableOnly || definition.canLaunch;
      return matchesKeyword && matchesCategory && matchesAvailability;
    });
  }, [availableOnly, category, keyword, permissionDefinitions]);

  const availableCount = permissionDefinitions.filter((definition) => definition.canLaunch).length;

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
        <div className="launch-overview-stats" aria-label="流程发起权限概览">
          <div><strong>{availableCount}</strong><span>可发起流程</span></div>
          <div><strong>3</strong><span>所属发起权限组</span></div>
          <div><strong>王敏</strong><span>当前用户 · 文控中心</span></div>
        </div>
      </Card>

      <Card className="query-card launch-query-card">
        <div className="launch-query-row">
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索流程名称或发起权限组"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            aria-label="搜索可发起流程"
          />
          <Select
            value={category}
            onChange={setCategory}
            aria-label="按流程类型筛选"
            options={[
              { value: "all", label: "全部类型" },
              { value: "approval", label: "固定审批" },
              { value: "free", label: "自由流程" },
            ]}
          />
          <Checkbox checked={availableOnly} onChange={(event) => setAvailableOnly(event.target.checked)}>
            仅看我可发起
          </Checkbox>
          <Typography.Text type="secondary">找到 {filteredDefinitions.length} 个流程</Typography.Text>
        </div>
      </Card>

      {filteredDefinitions.length > 0 ? (
        <section className="launch-definition-grid" aria-label="可发起流程列表">
          {filteredDefinitions.map((definition) => (
            <Card
              key={definition.id}
              className={`launch-definition-card tone-${definition.tone}${definition.canLaunch ? "" : " is-disabled"}`}
              hoverable={definition.canLaunch}
              onClick={() => definition.canLaunch && navigate(definition.route)}
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
                <span><TeamOutlined /><span>发起权限组</span><strong>{definition.permissionGroup}</strong></span>
                <span><ClockCircleOutlined /><span>更新时间</span><strong>{definition.updatedAt}</strong></span>
              </div>
              <div className="launch-card-foot">
                {definition.canLaunch ? (
                  <span className="launch-available"><CheckCircleFilled /> 当前账号可发起</span>
                ) : (
                  <Tooltip title={definition.unavailableReason}>
                    <span className="launch-unavailable"><LockOutlined /> {definition.unavailableReason}</span>
                  </Tooltip>
                )}
                <Button
                  type={definition.canLaunch ? "primary" : "default"}
                  disabled={!definition.canLaunch}
                  icon={<RightOutlined />}
                  aria-label={`发起${definition.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (definition.canLaunch) navigate(definition.route);
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
