import {
  AuditOutlined,
  BellOutlined,
  CheckSquareOutlined,
  ControlOutlined,
  DeploymentUnitOutlined,
  FileSearchOutlined,
  KeyOutlined,
  LogoutOutlined,
  MonitorOutlined,
  ReloadOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  SwapOutlined,
  TeamOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Avatar,
  Badge,
  Button,
  Divider,
  Drawer,
  Dropdown,
  Layout,
  List,
  Menu,
  Select,
  Space,
  Tag,
  Typography,
  type MenuProps,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { getProcessDefinition, processDefinitions } from "../data/processDefinitions";
import { ROLE_PERMISSIONS_CHANGED_EVENT, canPersonaAccessLaunch } from "../state/rolePermissions";
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { personas, usePrototypeStore, type PersonaId } from "../state/usePrototypeStore";

const { Header, Sider, Content } = Layout;

const pageMeta: Record<string, { title: string; eyebrow: string }> = {
  "/launch": { title: "流程发起", eyebrow: "员工工作区" },
  "/tasks": { title: "任务中心", eyebrow: "员工工作区" },
  "/admin/processes": { title: "流程管理", eyebrow: "流程配置" },
  "/free-flow/new": { title: "新建自由协作事项", eyebrow: "自由协作" },
  "/admin/users": { title: "用户管理", eyebrow: "用户与权限" },
  "/admin/departments": { title: "部门管理", eyebrow: "用户与权限" },
  "/admin/roles": { title: "角色管理", eyebrow: "用户与权限" },
  "/admin/permissions": { title: "权限管理", eyebrow: "用户与权限" },
  "/admin/workflow-groups": { title: "流程权限组", eyebrow: "用户与权限" },
  "/ops/instances": { title: "流程实例监控", eyebrow: "系统运维" },
  "/ops/audit-logs": { title: "操作审计日志", eyebrow: "系统运维" },
};

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [permissionRevision, setPermissionRevision] = useState(0);
  const {
    notices,
    personaId,
    switchPersona,
    markAllNoticesRead,
    logout,
    resetDemo,
  } = usePrototypeStore();

  const persona = personas.find((item) => item.id === personaId) ?? personas[2];
  const resetProcessDefinitions = useProcessDefinitionStore((state) => state.resetDefinitions);
  const unreadCount = notices.filter((item) => !item.read).length;
  const isAdmin = personaId === "admin";
  const canInitiate = canPersonaAccessLaunch(personaId);
  useEffect(() => {
    const refreshPermissions = () => setPermissionRevision((value) => value + 1);
    window.addEventListener(ROLE_PERMISSIONS_CHANGED_EVENT, refreshPermissions);
    return () => window.removeEventListener(ROLE_PERMISSIONS_CHANGED_EVENT, refreshPermissions);
  }, []);
  const processDefinition = getProcessDefinition(new URLSearchParams(location.search).get("definitionId"));
  const isDesignerRoute = /^\/admin\/processes\/[^/]+\/(form|flow)$/.test(location.pathname);
  const selectedKey = location.pathname.startsWith("/launch/")
    ? "/launch"
    : location.pathname.startsWith("/admin/processes/")
      ? "/admin/processes"
      : location.pathname === "/processes"
        ? `/processes?definitionId=${processDefinition.id}`
        : location.pathname;
  const meta = location.pathname.startsWith("/launch/")
    ? { title: "发起流程", eyebrow: "员工工作区" }
    : location.pathname.startsWith("/admin/processes/")
      ? location.pathname.endsWith("/basic")
        ? { title: "流程基本信息", eyebrow: "流程配置" }
        : location.pathname.endsWith("/form")
          ? { title: "初始表单设计", eyebrow: "流程配置" }
          : location.pathname.endsWith("/flow")
            ? { title: "可视化流程设计", eyebrow: "流程配置" }
        : location.pathname.endsWith("/publish")
          ? { title: "预览、校验与发布", eyebrow: "流程配置" }
          : { title: "流程版本记录", eyebrow: "流程配置" }
      : location.pathname.startsWith("/processes/")
    ? { title: "流程详情", eyebrow: "流程清单" }
    : location.pathname === "/processes"
      ? { title: processDefinition.label, eyebrow: "流程清单" }
      : pageMeta[location.pathname] ?? pageMeta["/tasks"];

  const menuItems: MenuProps["items"] = useMemo(
    () => ([
      {
        type: "group",
        label: "员工工作区",
        children: [
          ...(canInitiate ? [{ key: "/launch", icon: <RocketOutlined />, label: "流程发起" }] : []),
          { key: "/tasks", icon: <CheckSquareOutlined />, label: "任务中心" },
          {
            key: "/processes-menu",
            icon: <FileSearchOutlined />,
            label: "流程清单",
            children: processDefinitions.map((definition) => ({
              key: `/processes?definitionId=${definition.id}`,
              label: definition.label,
            })),
          },
        ],
      },
      ...(isAdmin ? [{
        type: "group",
        label: "流程配置",
        children: [
          { key: "/admin/processes", icon: <ControlOutlined />, label: "流程管理" },
        ],
      },
      {
        type: "group",
        label: "用户与权限",
        children: [
          { key: "/admin/users", icon: <UserOutlined />, label: "用户管理" },
          { key: "/admin/departments", icon: <DeploymentUnitOutlined />, label: "部门管理" },
          { key: "/admin/roles", icon: <SafetyCertificateOutlined />, label: "角色管理" },
          { key: "/admin/permissions", icon: <KeyOutlined />, label: "权限管理" },
          { key: "/admin/workflow-groups", icon: <TeamOutlined />, label: "流程权限组" },
        ],
      },
      {
        type: "group",
        label: "系统运维",
        children: [
          { key: "/ops/instances", icon: <MonitorOutlined />, label: "实例监控" },
          { key: "/ops/audit-logs", icon: <AuditOutlined />, label: "审计日志" },
        ],
      }] : []),
    ] as MenuProps["items"]),
    [canInitiate, isAdmin, permissionRevision],
  );

  const userMenu: MenuProps["items"] = [
    {
      key: "reset",
      icon: <ReloadOutlined />,
      label: "重置演示数据",
      onClick: () => {
        resetDemo();
        resetProcessDefinitions();
      },
    },
    { type: "divider" },
    {
      key: "logout",
      icon: <LogoutOutlined />,
      label: "退出登录",
      onClick: () => {
        logout();
        navigate("/login");
      },
    },
  ];

  return (
    <Layout className="app-layout">
      <Sider className="app-sider" width={248} theme="dark">
        <button className="brand" type="button" onClick={() => navigate("/tasks")}>
          <span className="brand-mark">FP</span>
          <span>
            <strong>FlowPilot</strong>
            <small>流程审核中心</small>
          </span>
        </button>

        <div className="tenant-chip">
          <span className="tenant-dot" />
          <span>公司内网 · 生产环境</span>
          <Tag bordered={false}>原型</Tag>
        </div>

        <div className="app-menu-scroll">
          <Menu
            className="app-menu"
            theme="dark"
            mode="inline"
            selectedKeys={[selectedKey]}
            defaultOpenKeys={["/processes-menu"]}
            items={menuItems}
            onClick={({ key }) => navigate(key)}
          />
        </div>

        <div className="sider-footnote">
          <SettingOutlined />
          <span>配置草稿会自动保存在本机</span>
        </div>
      </Sider>

      <Layout>
        <Header className="app-header">
          <div className="page-identity">
            <Typography.Text type="secondary">{meta.eyebrow}</Typography.Text>
            <Typography.Title level={4}>{meta.title}</Typography.Title>
          </div>
          <Space size={12}>
            <div className="persona-switcher">
              <SwapOutlined />
              <span>演示身份</span>
              <Select
                variant="borderless"
                value={personaId}
                popupMatchSelectWidth={220}
                onChange={(value: PersonaId) => switchPersona(value)}
                options={personas.map((item) => ({
                  value: item.id,
                  label: `${item.name} · ${item.role}`,
                }))}
              />
            </div>
            <Badge count={unreadCount} size="small">
              <Button
                aria-label="打开通知"
                className="header-icon-button"
                type="text"
                icon={<BellOutlined />}
                onClick={() => setNoticeOpen(true)}
              />
            </Badge>
            <Divider type="vertical" />
            <Dropdown menu={{ items: userMenu }} trigger={["click"]}>
              <button className="user-button" type="button">
                <Avatar className="user-avatar">{persona.name.slice(-1)}</Avatar>
                <span className="user-copy">
                  <strong>{persona.name}</strong>
                  <small>{persona.role}</small>
                </span>
              </button>
            </Dropdown>
          </Space>
        </Header>

        <Content className={`app-content${isDesignerRoute ? " is-designer-content" : ""}`}>
          <Outlet />
        </Content>
      </Layout>

      <Drawer
        title={
          <div className="drawer-title">
            <span>站内通知</span>
            <Badge count={unreadCount} />
          </div>
        }
        width={420}
        open={noticeOpen}
        onClose={() => setNoticeOpen(false)}
        extra={
          <Button type="link" disabled={!unreadCount} onClick={markAllNoticesRead}>
            全部已读
          </Button>
        }
      >
        <List
          className="notice-list"
          dataSource={notices}
          locale={{ emptyText: "暂无通知" }}
          renderItem={(item) => (
            <List.Item
              className={item.read ? "notice-item" : "notice-item is-unread"}
              onClick={() => {
                if (item.instanceId) navigate(`/processes/${item.instanceId}`);
                setNoticeOpen(false);
              }}
            >
              <List.Item.Meta
                avatar={<span className="notice-dot" />}
                title={item.title}
                description={
                  <>
                    <div>{item.detail}</div>
                    <small>{item.time}</small>
                  </>
                }
              />
            </List.Item>
          )}
        />
      </Drawer>
    </Layout>
  );
}
