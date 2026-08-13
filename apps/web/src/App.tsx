import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { FlowDesignerPage } from "./pages/FlowDesignerPage";
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

export default function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#3157d5",
          colorInfo: "#3157d5",
          colorSuccess: "#14866d",
          colorWarning: "#d08a18",
          colorError: "#d94b4b",
          colorText: "#17223b",
          colorTextSecondary: "#687289",
          colorBgLayout: "#f4f6fa",
          borderRadius: 9,
          borderRadiusLG: 14,
          fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
          controlHeight: 38,
        },
        components: {
          Button: { fontWeight: 600 },
          Card: { headerFontSize: 16 },
          Menu: { darkItemBg: "#17223b", darkSubMenuItemBg: "#17223b", darkItemSelectedBg: "#3157d5" },
          Table: { headerBg: "#f7f8fb", headerColor: "#4f5970", rowHoverBg: "#f6f8ff" },
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
              <Route path="/processes/:id" element={<ProcessDetailPage />} />
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
