import type { ProcessDefinition, ProcessVersion } from "../state/useProcessDefinitionStore";
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import type { ProcessInstance, WorkflowTask } from "../data/types";
import { usePrototypeStore } from "../state/usePrototypeStore";

/**
 * REST 响应写入的只读客户端缓存。领域命令仍由服务端/MSW handler执行，
 * 页面不得通过这里推演业务状态。
 */
export const cacheProcessDefinition = (definition: ProcessDefinition) => {
  useProcessDefinitionStore.setState((state) => ({
    definitions: state.definitions.some((item) => item.id === definition.id)
      ? state.definitions.map((item) => item.id === definition.id ? structuredClone(definition) : item)
      : [structuredClone(definition), ...state.definitions],
  }));
};

export const cacheProcessVersion = (definitionId: string, version: ProcessVersion) => {
  useProcessDefinitionStore.setState((state) => ({
    definitions: state.definitions.map((definition) => {
      if (definition.id !== definitionId) return definition;
      const versions = definition.versions.some((item) => item.id === version.id)
        ? definition.versions.map((item) => item.id === version.id ? structuredClone(version) : item)
        : [structuredClone(version), ...definition.versions];
      return {
        ...definition,
        versions,
        versionCount: Math.max(definition.versionCount ?? 0, versions.length),
        updatedAt: version.updatedAt,
        updatedBy: version.updatedBy,
        nextVersionNumber: Math.max(
          definition.nextVersionNumber,
          Number(version.version.match(/\d+/)?.[0] ?? 0) + 1,
        ),
      };
    }),
  }));
};

export const removeCachedProcessDefinition = (definitionId: string) => {
  useProcessDefinitionStore.setState((state) => ({ definitions: state.definitions.filter((item) => item.id !== definitionId) }));
};

export const removeCachedProcessVersion = (definitionId: string, versionId: string) => {
  useProcessDefinitionStore.setState((state) => ({
    definitions: state.definitions.flatMap((definition) => {
      if (definition.id !== definitionId) return [definition];
      const versions = definition.versions.filter((version) => version.id !== versionId);
      return versions.length ? [{
        ...definition,
        versions,
        versionCount: Math.max(versions.length, (definition.versionCount ?? definition.versions.length) - 1),
      }] : [];
    }),
  }));
};

export const cacheProcessRuntime = (instance: ProcessInstance, tasks?: WorkflowTask[]) => {
  usePrototypeStore.setState((state) => {
    const instances = state.instances.some((item) => item.id === instance.id)
      ? state.instances.map((item) => item.id === instance.id ? structuredClone(instance) : item)
      : [structuredClone(instance), ...state.instances];
    return {
      instances,
      tasks: tasks ? [
        ...state.tasks.filter((task) => task.instanceId !== instance.id),
        ...structuredClone(tasks),
      ] : state.tasks,
    };
  });
  useProcessDefinitionStore.getState().synchronizeInstanceCounts(usePrototypeStore.getState().instances);
};
