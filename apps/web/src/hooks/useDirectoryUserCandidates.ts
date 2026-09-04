import { App } from "antd";
import { useEffect, useState } from "react";
import type { DirectoryUser } from "../api/contracts";
import { ApiError } from "../api/client";
import { flowPilotApi } from "../api/flowPilotApi";

interface DirectoryUserCandidateOptions {
  keyword?: string;
  active: boolean;
  selectedIds?: string[];
  includeSearchResults?: boolean;
  errorMessage?: string;
}

export const mergeDirectoryUsers = (users: Array<DirectoryUser | undefined>) => {
  const byId = new Map<string, DirectoryUser>();
  users.forEach((user) => {
    if (user) byId.set(user.id, user);
  });
  return [...byId.values()];
};

export interface DirectoryUserSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  [key: string]: unknown;
}

export const includeUnresolvedDirectoryUserOptions = <T extends DirectoryUserSelectOption>(
  options: T[],
  selectedIds: string[],
) => [
  ...options,
  ...selectedIds
    .filter((id) => !options.some((option) => option.value === id))
    .map((value) => ({ value, label: "已删除用户", disabled: true }) as T),
];

export function useDirectoryUserCandidates({
  keyword = "",
  active,
  selectedIds = [],
  includeSearchResults = true,
  errorMessage = "人员候选加载失败，请重试",
}: DirectoryUserCandidateOptions) {
  const { message } = App.useApp();
  const [remoteUsers, setRemoteUsers] = useState<DirectoryUser[]>([]);
  const selectedKey = [...new Set(selectedIds)].sort().join(",");

  useEffect(() => {
    if (!active) {
      setRemoteUsers([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const uniqueSelectedIds = [...new Set(selectedIds)];
      const pageRequest = includeSearchResults
        ? flowPilotApi.directory.users({
            page: 1,
            pageSize: 100,
            q: keyword.trim() || undefined,
            status: "启用",
          }).then((page) => page.items)
        : Promise.resolve([] as DirectoryUser[]);
      void Promise.allSettled([
        pageRequest,
        ...uniqueSelectedIds.map((id) => flowPilotApi.directory.user(id)),
      ]).then(([pageResult, ...selectedResults]) => {
        if (cancelled) return;
        const pageUsers = pageResult.status === "fulfilled" ? pageResult.value : [];
        const selectedUsers = selectedResults.map((result) => result.status === "fulfilled" ? result.value : undefined);
        setRemoteUsers(mergeDirectoryUsers([...pageUsers, ...selectedUsers]));
        const hasUnexpectedFailure = pageResult.status === "rejected"
          || selectedResults.some((result) => result.status === "rejected"
            && !(result.reason instanceof ApiError && result.reason.status === 404));
        if (hasUnexpectedFailure) {
          message.error(errorMessage);
        }
      });
    }, includeSearchResults ? 200 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, errorMessage, includeSearchResults, keyword, message, selectedKey]);

  return remoteUsers;
}
