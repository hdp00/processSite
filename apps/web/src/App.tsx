import { App as AntApp, ConfigProvider, Spin } from "antd";
import { Result } from "antd";
import zhCN from "antd/locale/zh_CN";
import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, RouterProvider, createBrowserRouter, createRoutesFromElements, useParams } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { AppBackButton } from "./components/AppBackButton";
import { LoginPage } from "./pages/LoginPage";
import { canPersonaAccessLaunch, canPersonaLaunchDefinition, hasPersonaPermission } from "./state/rolePermissions";
import { getPublishedVersion, useProcessDefinitionStore } from "./state/useProcessDefinitionStore";
import { usePrototypeStore } from "./state/usePrototypeStore";
import { canUserViewInstance } from "./state/workflowAccess";

const FlowDesignerPage = lazy(() => import("./pages/FlowDesignerPage").then((module) => ({ default: module.FlowDesignerPage })));
const FreeFlowDetailPage = lazy(() => import("./pages/FreeFlowDetailPage").then((module) => ({ default: module.FreeFlowDetailPage })));
const FormDesignerPage = lazy(() => import("./pages/FormDesignerPage"));
const ProcessLaunchCenterPage = lazy(() => import("./pages/ProcessLaunchCenterPage").then((module) => ({ default: module.ProcessLaunchCenterPage })));
const ProcessBasicConfigPage = lazy(() => import("./pages/ProcessBasicConfigPage").then((module) => ({ default: module.ProcessBasicConfigPage })));
const ProcessManagementPage = lazy(() => import("./pages/ProcessManagementPage").then((module) => ({ default: module.ProcessManagementPage })));
const ProcessPublishPage = lazy(() => import("./pages/ProcessPublishPage").then((module) => ({ default: module.ProcessPublishPage })));
const ProcessStartPage = lazy(() => import("./pages/ProcessStartPage").then((module) => ({ default: module.ProcessStartPage })));
const ProcessVersionsPage = lazy(() => import("./pages/ProcessVersionsPage").then((module) => ({ default: module.ProcessVersionsPage })));
const ProcessDetailPage = lazy(() => import("./pages/ProcessDetailPage").then((module) => ({ default: module.ProcessDetailPage })));
const ProcessListPage = lazy(() => import("./pages/ProcessListPage").then((module) => ({ default: module.ProcessListPage })));
const ProcessPrintPage = lazy(() => import("./pages/ProcessPrintPage").then((module) => ({ default: module.ProcessPrintPage })));
const TaskCenterPage = lazy(() => import("./pages/TaskCenterPage").then((module) => ({ default: module.TaskCenterPage })));
const AuditLogPage = lazy(() => import("./pages/GovernancePages").then((module) => ({ default: module.AuditLogPage })));
const DepartmentManagementPage = lazy(() => import("./pages/GovernancePages").then((module) => ({ default: module.DepartmentManagementPage })));
const InstanceMonitorPage = lazy(() => import("./pages/GovernancePages").then((module) => ({ default: module.InstanceMonitorPage })));
const PermissionManagementPage = lazy(() => import("./pages/GovernancePages").then((module) => ({ default: module.PermissionManagementPage })));
const RoleManagementPage = lazy(() => import("./pages/GovernancePages").then((module) => ({ default: module.RoleManagementPage })));
const UserManagementPage = lazy(() => import("./pages/GovernancePages").then((module) => ({ default: module.UserManagementPage })));
const WorkflowPermissionGroupsPage = lazy(() => import("./pages/GovernancePages").then((module) => ({ default: module.WorkflowPermissionGroupsPage })));

function ProtectedRoute({ children }: { children: ReactNode }) {
  const authenticated = usePrototypeStore((state) => state.authenticated);
  return authenticated ? children : <Navigate to="/login" replace />;
}

function LoginRoute() {
  const authenticated = usePrototypeStore((state) => state.authenticated);
  return authenticated ? <Navigate to="/tasks" replace /> : <LoginPage />;
}

function PersonaGate({ scope, definitionId, permission, children }: { scope: "initiator" | "permission"; definitionId?: string; permission?: string; children: ReactNode }) {
  const personaId = usePrototypeStore((state) => state.personaId);
  const params = useParams<{ definitionId?: string }>();
  const targetDefinitionId = definitionId ?? params.definitionId;
  const targetDefinition = useProcessDefinitionStore((state) =>
    state.definitions.find((item) => item.id === targetDefinitionId),
  );
  const targetPublishedVersion = getPublishedVersion(targetDefinition);
  const allowed = scope === "permission"
    ? Boolean(permission && hasPersonaPermission(personaId, permission))
    : targetDefinitionId
      ? Boolean(
        targetDefinition
        && !targetDefinition.disabled
        && targetPublishedVersion
        && canPersonaLaunchDefinition(personaId, targetDefinitionId),
      )
      : canPersonaAccessLaunch(personaId);

  if (allowed) return children;
  return (
    <Result
      status="403"
      title="当前身份无权访问"
      subTitle={scope === "permission" ? "当前角色未获得此页面的查看权限。" : "发起流程需要同时拥有角色中的流程发起权限，并属于该流程的发起流程权限组。"}
      extra={<AppBackButton onClick={() => window.history.back()} />}
    />
  );
}

function ProcessDetailRoute() {
  const { id } = useParams();
  const personaId = usePrototypeStore((state) => state.personaId);
  const instance = usePrototypeStore((state) => state.instances.find((item) => item.id === id));
  if (!instance || !canUserViewInstance(personaId, instance)) {
    return <Result status="403" title="无权查看此流程" subTitle="流程数据范围会在每次打开详情时重新校验。" extra={<AppBackButton onClick={() => window.history.back()} />} />;
  }
  return instance?.workflowType === "free"
    ? <FreeFlowDetailPage instanceOverride={instance} />
    : <ProcessDetailPage />;
}

function ProcessPrintRoute() {
  const { id } = useParams();
  const personaId = usePrototypeStore((state) => state.personaId);
  const instance = usePrototypeStore((state) => state.instances.find((item) => item.id === id));
  return instance && hasPersonaPermission(personaId, "work-list:打印") && canUserViewInstance(personaId, instance)
    ? <ProcessPrintPage />
    : <Result status="403" title="无权打印此流程" />;
}

const router = createBrowserRouter(createRoutesFromElements(
  <>
    <Route path="/login" element={<LoginRoute />} />
    <Route path="/processes/:id/print" element={<ProtectedRoute><ProcessPrintRoute /></ProtectedRoute>} />
    <Route
      element={
        <ProtectedRoute>
          <AppShell />
        </ProtectedRoute>
      }
    >
      <Route index element={<Navigate to="/tasks" replace />} />
      <Route path="/launch" element={<PersonaGate scope="initiator"><ProcessLaunchCenterPage /></PersonaGate>} />
      <Route path="/launch/:definitionId" element={<PersonaGate scope="initiator"><ProcessStartPage /></PersonaGate>} />
      <Route path="/tasks" element={<PersonaGate scope="permission" permission="work-task:查看"><TaskCenterPage /></PersonaGate>} />
      <Route path="/processes" element={<PersonaGate scope="permission" permission="work-list:查看"><ProcessListPage /></PersonaGate>} />
      <Route path="/processes/:id" element={<ProcessDetailRoute />} />
      <Route path="/free-flow/new" element={<Navigate to="/launch/free-collaboration" replace />} />
      <Route path="/admin/processes" element={<PersonaGate scope="permission" permission="config-definition:查看"><ProcessManagementPage /></PersonaGate>} />
      <Route path="/admin/processes/:definitionId/basic" element={<PersonaGate scope="permission" permission="config-definition:编辑"><ProcessBasicConfigPage /></PersonaGate>} />
      <Route path="/admin/processes/:definitionId/form" element={<PersonaGate scope="permission" permission="config-form:编辑"><FormDesignerPage /></PersonaGate>} />
      <Route path="/admin/processes/:definitionId/flow" element={<PersonaGate scope="permission" permission="config-definition:编辑"><FlowDesignerPage /></PersonaGate>} />
      <Route path="/admin/processes/:definitionId/publish" element={<PersonaGate scope="permission" permission="config-definition:发布"><ProcessPublishPage /></PersonaGate>} />
      <Route path="/admin/processes/:definitionId/versions" element={<PersonaGate scope="permission" permission="config-definition:查看"><ProcessVersionsPage /></PersonaGate>} />
      <Route path="/admin/users" element={<PersonaGate scope="permission" permission="org-user:查看"><UserManagementPage /></PersonaGate>} />
      <Route path="/admin/departments" element={<PersonaGate scope="permission" permission="org-department:查看"><DepartmentManagementPage /></PersonaGate>} />
      <Route path="/admin/roles" element={<PersonaGate scope="permission" permission="org-role:查看"><RoleManagementPage /></PersonaGate>} />
      <Route path="/admin/permissions" element={<PersonaGate scope="permission" permission="org-role:授权"><PermissionManagementPage /></PersonaGate>} />
      <Route path="/admin/workflow-groups" element={<PersonaGate scope="permission" permission="org-group:查看"><WorkflowPermissionGroupsPage /></PersonaGate>} />
      <Route path="/ops/instances" element={<PersonaGate scope="permission" permission="system-monitor:查看"><InstanceMonitorPage /></PersonaGate>} />
      <Route path="/ops/audit-logs" element={<PersonaGate scope="permission" permission="system-audit:查看"><AuditLogPage /></PersonaGate>} />
      <Route path="/designer/form" element={<Navigate to="/admin/processes" replace />} />
      <Route path="/designer/flow" element={<Navigate to="/admin/processes" replace />} />
    </Route>
    <Route path="*" element={<Navigate to="/tasks" replace />} />
  </>,
));

export default function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#3659e3",
          colorInfo: "#3659e3",
          colorSuccess: "#0f8b6d",
          colorWarning: "#c77a10",
          colorError: "#d84952",
          colorText: "#15213a",
          colorTextSecondary: "#647087",
          colorBorder: "#dce2ec",
          colorBorderSecondary: "#e8ecf2",
          colorBgLayout: "#f1f4f9",
          colorBgContainer: "#ffffff",
          borderRadius: 10,
          borderRadiusLG: 16,
          boxShadowTertiary: "0 8px 24px rgba(26, 39, 67, 0.08)",
          fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
          controlHeight: 38,
        },
        components: {
          Button: { fontWeight: 650, primaryShadow: "0 6px 16px rgba(54, 89, 227, 0.22)" },
          Card: { headerFontSize: 15, headerHeight: 54 },
          Input: { activeBorderColor: "#7188ee", hoverBorderColor: "#9aaaf1", activeShadow: "0 0 0 3px rgba(54, 89, 227, 0.10)" },
          Select: { activeBorderColor: "#7188ee", hoverBorderColor: "#9aaaf1", activeOutlineColor: "rgba(54, 89, 227, 0.10)" },
          Menu: { darkItemBg: "#152039", darkSubMenuItemBg: "#111a2e", darkItemSelectedBg: "#3659e3", itemHeight: 44 },
          Table: { headerBg: "#f3f5f9", headerColor: "#46536b", rowHoverBg: "#f4f7ff", cellPaddingBlock: 14 },
          Modal: { titleFontSize: 17, headerBg: "#ffffff" },
          Drawer: { colorBgElevated: "#ffffff" },
        },
      }}
    >
      <AntApp>
        <Suspense fallback={<div className="route-loading"><Spin size="large" tip="页面加载中" /></div>}>
          <RouterProvider router={router} />
        </Suspense>
      </AntApp>
    </ConfigProvider>
  );
}
