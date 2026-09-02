import {
  AuditOutlined,
  CheckSquareOutlined,
  ControlOutlined,
  DeploymentUnitOutlined,
  FileSearchOutlined,
  KeyOutlined,
  LogoutOutlined,
  MonitorOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  SwapOutlined,
  TeamOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  App,
  Avatar,
  Divider,
  Dropdown,
  Layout,
  Menu,
  Select,
  Space,
  Typography,
  type MenuProps,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { flowPilotApi } from "../api/flowPilotApi";
import { ApiError } from "../api/client";
import { hydrateRemoteApplication } from "../api/remoteHydration";
import type { DirectoryUser } from "../api/contracts";
import { ROLE_PERMISSIONS_CHANGED_EVENT, canPersonaAccessLaunch, hasPersonaPermission } from "../state/rolePermissions";
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import {
  usePrototypeStore,
  type PersonaId,
} from "../state/usePrototypeStore";
import { useIdentityStore } from "../state/useIdentityStore";
import { canUserViewDefinition } from "../state/workflowAccess";

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
  const { message } = App.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [permissionRevision, setPermissionRevision] = useState(0);
  const [impersonationCandidates, setImpersonationCandidates] = useState<DirectoryUser[]>([]);
  const [switchingPersona, setSwitchingPersona] = useState(false);
  const {
    personaId,
    operatorUserId,
    operatorSuperAdmin,
    impersonation,
  } = usePrototypeStore();

  const identityUsers = useIdentityStore((state) => state.users);
  const identityUser = identityUsers.find((user) => user.id === personaId);
  const persona = identityUser
    ? { id: identityUser.id, name: identityUser.name, role: identityUser.roles.join("、") || identityUser.jobTitle }
    : { id: personaId, name: "当前用户", role: "身份信息加载中" };
  const managedDefinitions = useProcessDefinitionStore((state) => state.definitions);
  const canInitiate = canPersonaAccessLaunch(personaId);
  const can = (permission: string) => hasPersonaPermission(personaId, permission);
  useEffect(() => {
    const refreshPermissions = () => setPermissionRevision((value) => value + 1);
    window.addEventListener(ROLE_PERMISSIONS_CHANGED_EVENT, refreshPermissions);
    return () => window.removeEventListener(ROLE_PERMISSIONS_CHANGED_EVENT, refreshPermissions);
  }, []);
  useEffect(() => {
    if (!operatorSuperAdmin) return;
    const loadCandidates = async () => {
      const users: DirectoryUser[] = [];
      for (let page = 1; ; page += 1) {
        const result = await flowPilotApi.auth.impersonationCandidates({ page, pageSize: 100 });
        users.push(...result.items);
        if (page >= result.page.totalPages) return users;
      }
    };
    void loadCandidates()
      .then(setImpersonationCandidates)
      .catch(() => setImpersonationCandidates([]));
  }, [operatorSuperAdmin]);

  const finishIdentitySwitch = async () => {
    await hydrateRemoteApplication();
    setPermissionRevision((value) => value + 1);
    navigate("/tasks", { replace: true });
  };

  const selectPersona = async (targetUserId: PersonaId) => {
    if (targetUserId === operatorUserId) {
      if (!impersonation) return;
      setSwitchingPersona(true);
      try {
        await flowPilotApi.auth.stopImpersonation();
        await finishIdentitySwitch();
        message.success("已恢复超级管理员身份");
      } catch (error) {
        message.error(error instanceof ApiError ? error.message : "恢复身份失败");
      } finally {
        setSwitchingPersona(false);
      }
      return;
    }
    setSwitchingPersona(true);
    let restoredPreviousIdentity = false;
    try {
      if (impersonation) {
        await flowPilotApi.auth.stopImpersonation();
        restoredPreviousIdentity = true;
      }
      await flowPilotApi.auth.startImpersonation(
        targetUserId,
        `通过顶栏模拟身份选择器直接切换至 ${targetUserId}`,
      );
      await finishIdentitySwitch();
    } catch (error) {
      if (restoredPreviousIdentity) await finishIdentitySwitch();
      message.error(error instanceof ApiError ? error.message : "切换模拟身份失败");
    } finally {
      setSwitchingPersona(false);
    }
  };

  const personaOptions = impersonationCandidates.map((user) => ({
      value: user.id,
      label: `${user.name} · ${user.roles.join("、") || user.jobTitle}`,
      searchText: `${user.account} ${user.name} ${user.roles.join(" ")} ${user.jobTitle}`,
    }));
  if (operatorSuperAdmin && !personaOptions.some((option) => option.value === operatorUserId)) {
    const operator = useIdentityStore.getState().users.find((user) => user.id === operatorUserId);
    personaOptions.unshift({
      value: operatorUserId,
      label: `${operator?.name ?? "超级管理员"} · ${operator?.roles.join("、") || "系统内置"}`,
      searchText: `${operator?.account ?? operatorUserId} ${operator?.name ?? "超级管理员"} ${operator?.roles.join(" ") || "系统内置"}`,
    });
  }
  const selectedDefinitionId = new URLSearchParams(location.search).get("definitionId");
  const managedProcessDefinition = managedDefinitions.find((item) => item.id === selectedDefinitionId);
  const selectedProcessDefinitionId = selectedDefinitionId
    ?? managedDefinitions.find((definition) => Boolean(definition.publishedVersionId))?.id
    ?? "";
  const isDesignerRoute = /^\/admin\/processes\/[^/]+\/(form|flow)$/.test(location.pathname);
  const selectedKey = location.pathname.startsWith("/launch/")
    ? "/launch"
    : location.pathname.startsWith("/admin/processes/")
      ? "/admin/processes"
      : location.pathname === "/processes"
        ? `/processes?definitionId=${selectedProcessDefinitionId}`
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
      ? { title: managedProcessDefinition?.name ?? "流程清单", eyebrow: "流程清单" }
      : pageMeta[location.pathname] ?? pageMeta["/tasks"];

  const menuItems: MenuProps["items"] = useMemo(
    () => ([
      {
        type: "group",
        label: "员工工作区",
        children: [
          ...(canInitiate ? [{ key: "/launch", icon: <RocketOutlined />, label: "流程发起" }] : []),
          ...(can("work-task:查看") ? [{ key: "/tasks", icon: <CheckSquareOutlined />, label: "任务中心" }] : []),
          ...(can("work-list:查看") ? [{
            key: "/processes-menu",
            icon: <FileSearchOutlined />,
            label: "流程清单",
            children: managedDefinitions.filter((definition) => Boolean(
              definition.publishedVersionId
              && canUserViewDefinition(personaId, definition.id),
            )).map((definition) => ({
              key: `/processes?definitionId=${definition.id}`,
              label: definition.name,
            })),
          }] : []),
        ],
      },
      ...(can("config-definition:查看") ? [{
        type: "group",
        label: "流程配置",
        children: [
          { key: "/admin/processes", icon: <ControlOutlined />, label: "流程管理" },
        ],
      }] : []),
      ...(["org-user:查看", "org-department:查看", "org-role:查看", "org-group:查看"].some(can) ? [{
        type: "group",
        label: "用户与权限",
        children: [
          ...(can("org-user:查看") ? [{ key: "/admin/users", icon: <UserOutlined />, label: "用户管理" }] : []),
          ...(can("org-department:查看") ? [{ key: "/admin/departments", icon: <DeploymentUnitOutlined />, label: "部门管理" }] : []),
          ...(can("org-role:查看") ? [{ key: "/admin/roles", icon: <SafetyCertificateOutlined />, label: "角色管理" }] : []),
          ...(can("org-role:授权") ? [{ key: "/admin/permissions", icon: <KeyOutlined />, label: "权限管理" }] : []),
          ...(can("org-group:查看") ? [{ key: "/admin/workflow-groups", icon: <TeamOutlined />, label: "流程权限组" }] : []),
        ],
      }] : []),
      ...(["system-monitor:查看", "system-audit:查看"].some(can) ? [{
        type: "group",
        label: "系统运维",
        children: [
          ...(can("system-monitor:查看") ? [{ key: "/ops/instances", icon: <MonitorOutlined />, label: "实例监控" }] : []),
          ...(can("system-audit:查看") ? [{ key: "/ops/audit-logs", icon: <AuditOutlined />, label: "审计日志" }] : []),
        ],
      }] : []),
    ] as MenuProps["items"]),
    [canInitiate, managedDefinitions, permissionRevision, personaId],
  );

  const userMenu: MenuProps["items"] = [
    {
      key: "logout",
      icon: <LogoutOutlined />,
      label: "退出登录",
      onClick: () => {
        void flowPilotApi.auth.logout()
          .catch(() => undefined)
          .finally(() => navigate("/login", { replace: true }));
      },
    },
  ];

  return (
    <Layout className="app-layout">
      <Sider className="app-sider" width={248} theme="dark">
        <button className="brand" type="button" onClick={() => navigate("/tasks")}>
          <span className="brand-lockup">
            <span className="moons-wordmark" role="img" aria-label="MOONS'">
              <span className="moons-wordmark-name" aria-hidden="true">MOONS</span>
              <span className="moons-wordmark-apostrophe" aria-hidden="true">&apos;</span>
            </span>
            <small>FlowPilot · 流程审核中心</small>
          </span>
        </button>

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

      </Sider>

      <Layout>
        <Header className="app-header">
          <div className="page-identity">
            <Typography.Text type="secondary">{meta.eyebrow}</Typography.Text>
            <Typography.Title level={4}>{meta.title}</Typography.Title>
          </div>
          <Space size={12}>
            {operatorSuperAdmin && <div className="persona-switcher">
              <SwapOutlined />
              <span>模拟身份</span>
              <Select
                aria-label="切换模拟身份"
                variant="borderless"
                value={personaId}
                loading={switchingPersona}
                showSearch
                optionFilterProp="searchText"
                popupMatchSelectWidth={220}
                onChange={(value: PersonaId) => void selectPersona(value)}
                options={personaOptions}
              />
            </div>}
            {operatorSuperAdmin && <Divider orientation="vertical" />}
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

    </Layout>
  );
}
