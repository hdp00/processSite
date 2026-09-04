// @vitest-environment jsdom

import { App } from "antd";
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectoryUser } from "../api/contracts";
import { flowPilotApi } from "../api/flowPilotApi";
import { includeUnresolvedDirectoryUserOptions, mergeDirectoryUsers, useDirectoryUserCandidates } from "./useDirectoryUserCandidates";

const user = (id: string, name: string): DirectoryUser => ({
  id,
  account: id,
  email: `${id}@example.test`,
  name,
  authenticationMode: "domain",
  department: [],
  departmentPath: "",
  jobTitle: "",
  roles: [],
  status: "启用",
  lastLogin: "",
});

describe("mergeDirectoryUsers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps selected-user detail over the search-page copy and removes missing users", () => {
    expect(mergeDirectoryUsers([
      user("user-1", "旧姓名"),
      undefined,
      user("user-1", "最新姓名"),
      user("user-2", "李文"),
    ]).map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "user-1", name: "最新姓名" },
      { id: "user-2", name: "李文" },
    ]);
  });

  it("uses a readable disabled option instead of exposing a missing selected user id", () => {
    expect(includeUnresolvedDirectoryUserOptions(
      [{ value: "user-1", label: "王敏" }],
      ["user-1", "deleted-user-id"],
    )).toEqual([
      { value: "user-1", label: "王敏" },
      { value: "deleted-user-id", label: "已删除用户", disabled: true },
    ]);
  });

  it("loads an already-selected user by id without downloading the user directory", async () => {
    const selected = user("selected-user", "王敏");
    const userSpy = vi.spyOn(flowPilotApi.directory, "user").mockResolvedValue(selected);
    const usersSpy = vi.spyOn(flowPilotApi.directory, "users");
    const wrapper = ({ children }: { children: ReactNode }) => createElement(App, null, children);

    const { result } = renderHook(() => useDirectoryUserCandidates({
      active: true,
      selectedIds: [selected.id],
      includeSearchResults: false,
    }), { wrapper });

    await waitFor(() => expect(result.current).toEqual([selected]));
    expect(userSpy).toHaveBeenCalledWith(selected.id);
    expect(usersSpy).not.toHaveBeenCalled();
  });
});
