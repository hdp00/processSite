import type { DirectoryUser } from "../api/contracts";
import type { ProcessVersion } from "../state/useProcessDefinitionStore";

export const processVersionReferencedUserIds = (version: ProcessVersion | undefined) => [...new Set([
  ...(version?.basic.visibleUsers ?? []),
  ...(version?.snapshot.flow.nodes.flatMap((node) => node.data?.emailNotification?.extraUserIds ?? []) ?? []),
])];

export const directoryUserDisplay = (
  users: DirectoryUser[],
  userId: string,
  includeEmail = false,
) => {
  const user = users.find((item) => item.id === userId);
  if (!user) return "已删除用户";
  const email = String(user.email ?? "").trim();
  return includeEmail
    ? `${user.name}${email ? ` <${email}>` : "（未维护邮箱）"}`
    : user.name;
};
