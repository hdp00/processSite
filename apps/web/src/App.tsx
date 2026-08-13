import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { FlowDesignerPage } from "./pages/FlowDesignerPage";
import { FreeFlowCreatePage } from "./pages/FreeFlowCreatePage";
import { FreeFlowDetailPage } from "./pages/FreeFlowDetailPage";
import FormDesignerPage from "./pages/FormDesignerPage";
import { LoginPage } from "./pages/LoginPage";
import { ProcessDetailPage } from "./pages/ProcessDetailPage";
import { ProcessListPage } from "./pages/ProcessListPage";
import { ProcessPrintPage } from "./pages/ProcessPrintPage";
import { TaskCenterPage } from "./pages/TaskCenterPage";
import { usePrototypeStore } from "./state/usePrototypeStore";

function ProtectedRoute({ children }: { children: ReactNode }) {
  const authenticated = usePrototypeStore((state) => state.authenticated);
  return authenticated ? children : <Navigate to="/login" replace />;
}

function LoginRoute() {
  const authenticated = usePrototypeStore((state) => state.authenticated);
  return authenticated ? <Navigate to="/tasks" replace /> : <LoginPage />;
}

function ProcessDetailRoute() {
  const { id } = useParams();
  const instance = usePrototypeStore((state) => state.instances.find((item) => item.id === id));
  return instance?.workflowType === "free"
    ? <FreeFlowDetailPage instanceOverride={instance} />
    : <ProcessDetailPage />;
}

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
        <BrowserRouter>
          <Routes>
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
              <Route path="/tasks" element={<TaskCenterPage />} />
              <Route path="/processes" element={<ProcessListPage />} />
              <Route path="/processes/:id" element={<ProcessDetailRoute />} />
              <Route path="/free-flow/new" element={<FreeFlowCreatePage />} />
              <Route path="/designer/form" element={<FormDesignerPage />} />
              <Route path="/designer/flow" element={<FlowDesignerPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/tasks" replace />} />
          </Routes>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  );
}
