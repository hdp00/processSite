// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";

const { loginMock, hydrateMock } = vi.hoisted(() => ({
  loginMock: vi.fn(),
  hydrateMock: vi.fn(),
}));

vi.mock("../api/flowPilotApi", () => ({
  flowPilotApi: {
    auth: {
      login: loginMock,
    },
  },
}));

vi.mock("../api/remoteHydration", () => ({
  hydrateRemoteApplication: hydrateMock,
}));

const renderLoginPage = () => render(
  <MemoryRouter initialEntries={["/login"]}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/tasks" element={<h1>任务中心测试页</h1>} />
    </Routes>
  </MemoryRouter>,
);

describe("登录页", () => {
  beforeEach(() => {
    window.localStorage.clear();
    loginMock.mockReset();
    hydrateMock.mockReset();
  });

  it("Debug 登录页固定超级管理员账号，并阻止空密码提交", async () => {
    const user = userEvent.setup();
    renderLoginPage();

    const usernameInput = screen.getByPlaceholderText("请输入账号");
    expect(usernameInput).toHaveValue("superadmin");
    expect(usernameInput).toHaveAttribute("readonly");
    expect(screen.queryByLabelText("选择演示身份")).not.toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText("请输入密码"));
    await user.click(screen.getByRole("button", { name: /登录/ }));

    expect(await screen.findByText("请输入密码")).toBeInTheDocument();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("登录成功后保存账号并替换导航至任务中心", async () => {
    loginMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderLoginPage();

    await user.click(screen.getByRole("button", { name: /登录/ }));

    await waitFor(() => expect(loginMock).toHaveBeenCalledWith("superadmin", "1"), { timeout: 5_000 });
    expect(await screen.findByRole(
      "heading",
      { name: "任务中心测试页" },
      { timeout: 5_000 },
    )).toBeInTheDocument();
    expect(window.localStorage.getItem("flowpilot-last-successful-login-username")).toBe("superadmin");
    expect(hydrateMock).not.toHaveBeenCalled();
  });

  it("登录失败时保留在当前页并给出失败反馈", async () => {
    loginMock.mockRejectedValue(new Error("network unavailable"));
    const user = userEvent.setup();
    renderLoginPage();

    await user.clear(screen.getByPlaceholderText("请输入密码"));
    await user.type(screen.getByPlaceholderText("请输入密码"), "bad-password");
    await user.click(screen.getByRole("button", { name: /登录/ }));

    await waitFor(() => expect(loginMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("登录失败，请稍后重试")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /登录/ })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: "任务中心测试页" })).not.toBeInTheDocument();
  });
});
