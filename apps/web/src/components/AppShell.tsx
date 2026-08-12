import {
  ApartmentOutlined,
  BellOutlined,
  CheckSquareOutlined,
  FileSearchOutlined,
  FormOutlined,
  LogoutOutlined,
  ReloadOutlined,
  SettingOutlined,
  SwapOutlined,
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
import { useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { personas, usePrototypeStore, type PersonaId } from "../state/usePrototypeStore";

const { Header, Sider, Content } = Layout;

const pageMeta: Record<string, { title: string; eyebrow: string }> = {
  "/tasks": { title: "任务中心", eyebrow: "员工工作区" },
  "/processes": { title: "所有流程", eyebrow: "员工工作区" },
  "/designer/form": { title: "初始表单设计器", eyebrow: "流程配置" },
  "/designer/flow": { title: "可视化流程设计器", eyebrow: "流程配置" },
};

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [noticeOpen, setNoticeOpen] = useState(false);
  const {
    notices,
    personaId,
    switchPersona,
    markAllNoticesRead,
    logout,
    resetDemo,
  } = usePrototypeStore();

  const persona = personas.find((item) => item.id === personaId) ?? personas[2];
  const unreadCount = notices.filter((item) => !item.read).length;
  const selectedKey = location.pathname.startsWith("/processes/")
    ? "/processes"
    : location.pathname;
  const meta = location.pathname.startsWith("/processes/")
    ? { title: "流程详情", eyebrow: "员工工作区" }
    : pageMeta[location.pathname] ?? pageMeta["/tasks"];

  const menuItems: MenuProps["items"] = useMemo(
    () => [
      {
        type: "group",
        label: "员工工作区",
        children: [
          { key: "/tasks", icon: <CheckSquareOutlined />, label: "任务中心" },
          { key: "/processes", icon: <FileSearchOutlined />, label: "所有流程" },
        ],
      },
      {
        type: "group",
        label: "流程配置",
        children: [
          { key: "/designer/form", icon: <FormOutlined />, label: "表单设计器" },
          { key: "/designer/flow", icon: <ApartmentOutlined />, label: "流程设计器" },
        ],
      },
    ],
    [],
  );

  const userMenu: MenuProps["items"] = [
    {
      key: "reset",
      icon: <ReloadOutlined />,
      label: "重置演示数据",
      onClick: () => resetDemo(),
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

        <Menu
          className="app-menu"
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />

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

        <Content className="app-content">
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
