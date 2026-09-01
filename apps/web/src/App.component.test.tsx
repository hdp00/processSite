// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { PersonaGate, ProtectedRoute } from "./App";
import { usePrototypeStore } from "./state/usePrototypeStore";

describe("应用路由权限", () => {
  beforeEach(() => {
    usePrototypeStore.setState({
      authenticated: false,
      personaId: "lina",
      operatorUserId: "lina",
      sessionPermissions: [],
      sessionSuperAdmin: false,
      operatorSuperAdmin: false,
      impersonation: undefined,
    });
  });

  it("未登录访问受保护页面时跳转至登录页", async () => {
    render(
      <MemoryRouter initialEntries={["/tasks"]}>
        <Routes>
          <Route path="/login" element={<h1>登录页</h1>} />
          <Route
            path="/tasks"
            element={<ProtectedRoute><h1>任务中心</h1></ProtectedRoute>}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "登录页" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "任务中心" })).not.toBeInTheDocument();
  });

  it("已登录但缺少页面权限时展示 403，而不是渲染目标页面", () => {
    usePrototypeStore.setState({ authenticated: true, personaId: "hejing", operatorUserId: "hejing" });

    render(
      <MemoryRouter initialEntries={["/ops/audit-logs"]}>
        <Routes>
          <Route
            path="/ops/audit-logs"
            element={
              <ProtectedRoute>
                <PersonaGate scope="permission" permission="system-audit:查看">
                  <h1>审计日志</h1>
                </PersonaGate>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("当前身份无权访问")).toBeInTheDocument();
    expect(screen.getByText("当前角色未获得此页面的查看权限。")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "审计日志" })).not.toBeInTheDocument();
  });

  it("超级管理员可通过同一权限守卫访问页面", () => {
    usePrototypeStore.setState({
      authenticated: true,
      personaId: "superadmin",
      operatorUserId: "superadmin",
      sessionSuperAdmin: true,
      operatorSuperAdmin: true,
    });

    render(
      <MemoryRouter initialEntries={["/ops/audit-logs"]}>
        <Routes>
          <Route
            path="/ops/audit-logs"
            element={
              <ProtectedRoute>
                <PersonaGate scope="permission" permission="system-audit:查看">
                  <h1>审计日志</h1>
                </PersonaGate>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "审计日志" })).toBeInTheDocument();
    expect(screen.queryByText("当前身份无权访问")).not.toBeInTheDocument();
  });
});
