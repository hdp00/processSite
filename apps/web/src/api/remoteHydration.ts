import type { PageResult, ProcessDefinitionListItem } from "./contracts";
import { useIdentityStore } from "../state/useIdentityStore";
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { usePrototypeStore } from "../state/usePrototypeStore";
import { flowPilotApi } from "./flowPilotApi";
import { useOrganizationStore } from "../state/useOrganizationStore";

const collectPages = async <T>(loader: (page: number) => Promise<PageResult<T>>) => {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const result = await loader(page);
    items.push(...result.items);
    if (page >= result.page.totalPages) return items;
  }
};

/**
 * 远程模式的唯一启动水合入口。页面读取的 Zustand 数据在该模式下只是
 * 服务端查询结果缓存，不再使用内置演示种子冒充远程数据。
 */
export const hydrateRemoteApplication = async () => {
  const loadDefinitions = async () => {
    try {
      return collectPages<ProcessDefinitionListItem>((page) =>
        flowPilotApi.definitions.list({ page, pageSize: 100 }));
    } catch {
      return collectPages<ProcessDefinitionListItem>((page) =>
        flowPilotApi.definitions.visible({ page, pageSize: 100 }));
    }
  };
  const [roles, workflowGroups, definitions, departments, positions] = await Promise.all([
    collectPages((page) => flowPilotApi.directory.roles({ page, pageSize: 100 })),
    collectPages((page) => flowPilotApi.directory.groups({ page, pageSize: 100 })),
    loadDefinitions(),
    flowPilotApi.organization.departments(),
    flowPilotApi.organization.positions(),
  ]);

  // Commit the new cache only after every critical query succeeds. A temporary
  // backend failure must not turn into a persisted "zero data" application.
  const session = usePrototypeStore.getState();
  const sessionUsers = useIdentityStore.getState().users.filter((user) =>
    user.id === session.personaId || user.id === session.operatorUserId,
  );
  useIdentityStore.setState({ users: sessionUsers, roles, workflowGroups });

  useProcessDefinitionStore.setState({
    definitions: definitions.map(({ status: _status, ...definition }) => definition),
  });
  usePrototypeStore.setState({
    instances: [],
    tasks: [],
  });
  useOrganizationStore.setState({
    departments: departments.map((department) => ({
        key: department.id,
        name: department.name,
        path: department.path,
        level: department.parentId ? 2 : 1,
        parentKey: department.parentId,
        sort: department.sortOrder,
        status: department.status,
        users: department.memberCount,
        referenced: department.memberCount > 0,
        description: department.description ?? "",
      })),
    jobTitles: positions.map((position, index) => ({
        id: position.id,
        name: position.name,
        description: position.description,
        status: position.status,
        users: position.memberCount,
        sort: position.sortOrder ?? (index + 1) * 10,
      })),
  });
};
