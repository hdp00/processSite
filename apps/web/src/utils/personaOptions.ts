import type { DomainUser } from "../state/useIdentityStore";

export interface PersonaOption {
  value: string;
  label: string;
  searchText: string;
}

export function buildDebugPersonaOptions(users: readonly DomainUser[]): PersonaOption[] {
  const enabledUsers = users.filter((user) => user.status === "启用");
  const superAdmin = enabledUsers.find((user) => user.id === "superadmin");
  const orderedUsers = superAdmin
    ? [superAdmin, ...enabledUsers.filter((user) => user.id !== superAdmin.id)]
    : enabledUsers;

  return orderedUsers.map((user) => {
    const roleLabel = user.builtIn
      ? "系统内置 · 全部权限"
      : user.roles.join("、") || user.jobTitle;
    return {
      value: user.id,
      label: `${user.name} · ${roleLabel}`,
      searchText: `${user.account} ${user.name} ${user.roles.join(" ")} ${user.jobTitle}`,
    };
  });
}
