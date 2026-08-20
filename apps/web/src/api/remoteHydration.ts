import type { PageResult, ProcessDefinitionListItem, WorkflowTaskListItem } from "./contracts";
import type { ProcessInstance } from "../data/types";
import { useIdentityStore } from "../state/useIdentityStore";
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { usePrototypeStore } from "../state/usePrototypeStore";
import { flowPilotApi } from "./flowPilotApi";

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
  const [directory, definitions, instances, taskItems] = await Promise.all([
    flowPilotApi.directory.snapshot(),
    collectPages<ProcessDefinitionListItem>((page) => flowPilotApi.definitions.list({ page, pageSize: 100 })),
    collectPages<ProcessInstance>((page) => flowPilotApi.instances.list({ page, pageSize: 100 })),
    collectPages<WorkflowTaskListItem>((page) => flowPilotApi.tasks.listMine({ page, pageSize: 100, view: "all" })),
  ]);
  useIdentityStore.setState({
    users: directory.users.map((user) => ({ ...user, password: "" })),
    roles: directory.roles,
    workflowGroups: directory.workflowGroups,
  });
  useProcessDefinitionStore.setState({ definitions: definitions.map(({ status: _status, ...definition }) => definition) });
  const instanceById = new Map(instances.map((instance) => [instance.id, instance]));
  taskItems.forEach((item) => instanceById.set(item.instance.id, item.instance));
  usePrototypeStore.setState({
    instances: [...instanceById.values()],
    tasks: taskItems.map((item) => item.task),
  });
};

