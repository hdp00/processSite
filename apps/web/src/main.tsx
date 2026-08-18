import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@xyflow/react/dist/style.css";
import "./styles.css";

const renderApp = () => ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

const bootstrap = async () => {
  if (import.meta.env.VITE_API_MODE !== "remote") {
    const { startMockApi } = await import("./mocks/browser");
    await startMockApi();
  }
  renderApp();
};

void bootstrap().catch((error) => {
  console.error("REST API 初始化失败", error);
  renderApp();
});
