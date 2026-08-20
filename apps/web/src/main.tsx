import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { writeApiAccessToken } from "./api/client";
import { flowPilotApi } from "./api/flowPilotApi";
import { hydrateRemoteApplication } from "./api/remoteHydration";
import "@xyflow/react/dist/style.css";
import "./styles.css";

const renderApp = () => ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

const bootstrap = async () => {
  const mockApiEnabled = import.meta.env.VITE_API_MODE === "mock"
    || (import.meta.env.DEV && import.meta.env.VITE_API_MODE !== "remote");
  if (mockApiEnabled) {
    const { startMockApi } = await import("./mocks/browser");
    await startMockApi();
  } else {
    try {
      await flowPilotApi.auth.me();
      await hydrateRemoteApplication();
    } catch {
      writeApiAccessToken();
      const { usePrototypeStore } = await import("./state/usePrototypeStore");
      usePrototypeStore.getState().logout();
    }
  }
  renderApp();
};

void bootstrap().catch((error) => {
  console.error("REST API 初始化失败", error);
  renderApp();
});
