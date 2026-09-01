import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ApiError } from "./api/client";
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
  let sessionRecovered = false;
  try {
    await flowPilotApi.auth.me();
    sessionRecovered = true;
    await hydrateRemoteProcessDefinitions();
  } catch (error) {
    if (sessionRecovered) {
      // 会话已经由后端确认有效。目录数据的临时加载失败不应注销用户，
      // 各业务页面会继续按需从后端重试自己的查询。
      console.error("后端基础目录初始化失败，页面将按需重试", error);
    } else {
      if (error instanceof ApiError && error.status === 401) clearRemoteApplicationCache();
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
