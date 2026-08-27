import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ApiError, writeApiAccessToken } from "./api/client";
import { clearRemoteApplicationCache, flowPilotApi } from "./api/flowPilotApi";
import { hydrateRemoteProcessDefinitions } from "./api/remoteHydration";
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
    let sessionRecovered = false;
    try {
      await flowPilotApi.auth.me();
      sessionRecovered = true;
      await hydrateRemoteProcessDefinitions();
    } catch (error) {
      if (sessionRecovered) {
        await flowPilotApi.auth.logout({ clearCache: false }).catch(() => undefined);
      } else {
        writeApiAccessToken();
        if (error instanceof ApiError && error.status === 401) {
          clearRemoteApplicationCache();
        }
        const { usePrototypeStore } = await import("./state/usePrototypeStore");
        usePrototypeStore.getState().logout();
      }
    }
  }
  renderApp();
};

void bootstrap().catch((error) => {
  console.error("REST API 初始化失败", error);
  renderApp();
});
