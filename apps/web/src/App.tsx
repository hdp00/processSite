import { App as AntApp, ConfigProvider } from "antd";
import { Button, Result } from "antd";
import zhCN from "antd/locale/zh_CN";
import type { ReactNode } from "react";
import { Navigate, Route, RouterProvider, createBrowserRouter, createRoutesFromElements, useParams } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { FlowDesignerPage } from "./pages/FlowDesignerPage";
import { FreeFlowCreatePage } from "./pages/FreeFlowCreatePage";
import { FreeFlowDetailPage } from "./pages/FreeFlowDetailPage";
import FormDesignerPage from "./pages/FormDesignerPage";
import {
  AuditLogPage,
  DepartmentManagementPage,
  InstanceMonitorPage,
  PermissionManagementPage,
  RoleManagementPage,
  UserManagementPage,
  WorkflowPermissionGroupsPage,
} from "./pages/GovernancePages";
import { LoginPage } from "./pages/LoginPage";
import { ProcessLaunchCenterPage } from "./pages/ProcessLaunchCenterPage";
import { ProcessBasicConfigPage } from "./pages/ProcessBasicConfigPage";
import { ProcessManagementPage } from "./pages/ProcessManagementPage";
import { ProcessPublishPage } from "./pages/ProcessPublishPage";
import { ProcessStartPage } from "./pages/ProcessStartPage";
import { ProcessVersionsPage } from "./pages/ProcessVersionsPage";
import { ProcessDetailPage } from "./pages/ProcessDetailPage";
import { ProcessListPage } from "./pages/ProcessListPage";
import { ProcessPrintPage } from "./pages/ProcessPrintPage";
import { TaskCenterPage } from "./pages/TaskCenterPage";
import { canPersonaAccessLaunch, canPersonaLaunchDefinition } from "./state/rolePermissions";
import { usePrototypeStore } from "./state/usePrototypeStore";

function ProtectedRoute({ children }: { children: ReactNode }) {
  const authenticated = usePrototypeStore((state) => state.authenticated);
  return authenticated ? children : <Navigate to="/login" replace />;
}

function LoginRoute() {
  const authenticated = usePrototypeStore((state) => state.authenticated);
  return authenticated ? <Navigate to="/tasks" replace /> : <LoginPage />;
}

function PersonaGate({ scope, definitionId, children }: { scope: "initiator" | "admin"; definitionId?: string; children: ReactNode }) {
  const personaId = usePrototypeStore((state) => state.personaId);
  const params = useParams<{ definitionId?: string }>();
  const targetDefinitionId = definitionId ?? params.definitionId;
  const allowed = scope === "admin"
    ? personaId === "admin"
    : targetDefinitionId
      ? canPersonaLaunchDefinition(personaId, targetDefinitionId)
      : canPersonaAccessLaunch(personaId);

  if (allowed) return children;
  return (
    <Result
      status="403"
      title="当前身份无权访问"
      subTitle={scope === "admin" ? "请切换为系统管理员身份后查看此管理页面。" : "发起流程需要同时拥有角色中的流程发起权限，并属于该流程的发起流程权限组。"}
      extra={<Button type="primary" onClick={() => window.history.back()}>返回上一页</Button>}
    />
  );
}

function ProcessDetailRoute() {
  const { id } = useParams();
  const instance = usePrototypeStore((state) => state.instances.find((item) => item.id === id));
  return instance?.workflowType === "free"
    ? <FreeFlowDetailPage instanceOverride={instance} />
    : <ProcessDetailPage />;
}

const router = createBrowserRouter(createRoutesFromElements(
  <>
    <Route path="/login" element={<LoginRoute />} />
    <Route path="/processes/:id/print" element={<ProtectedRoute><ProcessPrintPage /></ProtectedRoute>} />
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
      <Route path="/tasks" element={<TaskCenterPage />} />
      <Route path="/processes" element={<ProcessListPage />} />
      <Route path="/processes/:id" element={<ProcessDetailRoute />} />
      <Route path="/free-flow/new" element={<PersonaGate scope="initiator" definitionId="free-collaboration"><FreeFlowCreatePage /></PersonaGate>} />
      <Route path="/admin/processes" element={<PersonaGate scope="admin"><ProcessManagementPage /></PersonaGate>} />
      <Route path="/admin/processes/:definitionId/basic" element={<PersonaGate scope="admin"><ProcessBasicConfigPage /></PersonaGate>} />
      <Route path="/admin/processes/:definitionId/form" element={<PersonaGate scope="admin"><FormDesignerPage /></PersonaGate>} />
      <Route path="/admin/processes/:definitionId/flow" element={<PersonaGate scope="admin"><FlowDesignerPage /></PersonaGate>} />
      <Route path="/admin/processes/:definitionId/publish" element={<PersonaGate scope="admin"><ProcessPublishPage /></PersonaGate>} />
      <Route path="/admin/processes/:definitionId/versions" element={<PersonaGate scope="admin"><ProcessVersionsPage /></PersonaGate>} />
      <Route path="/admin/users" element={<PersonaGate scope="admin"><UserManagementPage /></PersonaGate>} />
      <Route path="/admin/departments" element={<PersonaGate scope="admin"><DepartmentManagementPage /></PersonaGate>} />
      <Route path="/admin/roles" element={<PersonaGate scope="admin"><RoleManagementPage /></PersonaGate>} />
      <Route path="/admin/permissions" element={<PersonaGate scope="admin"><PermissionManagementPage /></PersonaGate>} />
      <Route path="/admin/workflow-groups" element={<PersonaGate scope="admin"><WorkflowPermissionGroupsPage /></PersonaGate>} />
      <Route path="/ops/instances" element={<PersonaGate scope="admin"><InstanceMonitorPage /></PersonaGate>} />
      <Route path="/ops/audit-logs" element={<PersonaGate scope="admin"><AuditLogPage /></PersonaGate>} />
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
        <RouterProvider router={router} />
      </AntApp>
    </ConfigProvider>
  );
}
