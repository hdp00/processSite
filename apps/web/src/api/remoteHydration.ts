import type { PageResult, ProcessDefinitionListItem, WorkflowTaskListItem } from "./contracts";
import type { ProcessInstance } from "../data/types";
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
      return await collectPages<ProcessDefinitionListItem>((page) =>
        flowPilotApi.definitions.list({ page, pageSize: 100 }));
    } catch {
      return collectPages<ProcessDefinitionListItem>((page) =>
        flowPilotApi.definitions.visible({ page, pageSize: 100 }));
    }
  };
  const [directoryResult, definitionsResult, instancesResult, taskItemsResult, departmentsResult, positionsResult] = await Promise.allSettled([
    flowPilotApi.directory.snapshot(),
    loadDefinitions(),
    collectPages<ProcessInstance>((page) => flowPilotApi.instances.list({ page, pageSize: 100 })),
    collectPages<WorkflowTaskListItem>((page) => flowPilotApi.tasks.listMine({ page, pageSize: 100, view: "all" })),
    flowPilotApi.organization.departments(),
    flowPilotApi.organization.positions(),
  ]);

  if (directoryResult.status === "fulfilled") {
    const directory = directoryResult.value;
    useIdentityStore.setState({
      users: directory.users.map((user) => ({ ...user, password: "" })),
      roles: directory.roles,
      workflowGroups: directory.workflowGroups,
    });
  } else {
    const session = usePrototypeStore.getState();
    const sessionUsers = useIdentityStore.getState().users.filter((user) =>
      user.id === session.personaId || user.id === session.operatorUserId,
    );
    useIdentityStore.setState({
      users: sessionUsers,
      roles: [],
      workflowGroups: [],
    });
  }

  const definitions = definitionsResult.status === "fulfilled" ? definitionsResult.value : [];
  useProcessDefinitionStore.setState({
    definitions: definitions.map(({ status: _status, ...definition }) => definition),
  });
  const instances = instancesResult.status === "fulfilled" ? instancesResult.value : [];
  const taskItems = taskItemsResult.status === "fulfilled" ? taskItemsResult.value : [];
  const instanceById = new Map(instances.map((instance) => [instance.id, instance]));
  taskItems.forEach((item) => instanceById.set(item.instance.id, item.instance));
  usePrototypeStore.setState({
    instances: [...instanceById.values()],
    tasks: taskItems.map((item) => item.task),
  });
  useOrganizationStore.setState({
    departments: departmentsResult.status === "fulfilled"
      ? departmentsResult.value.map((department) => ({
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
      }))
      : [],
    jobTitles: positionsResult.status === "fulfilled"
      ? positionsResult.value.map((position, index) => ({
        id: position.id,
        name: position.name,
        description: position.description,
        status: position.status,
        users: position.memberCount,
        sort: position.sortOrder ?? (index + 1) * 10,
      }))
      : [],
  });
};
