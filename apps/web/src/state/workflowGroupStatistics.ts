import type { WorkflowTask } from "../data/types";
import type { ProcessDefinition } from "./useProcessDefinitionStore";
import type { WorkflowPermissionGroup } from "./useIdentityStore";

const referencesGroup = (value: string | undefined, group: WorkflowPermissionGroup) =>
  value === group.id || value === group.name;

export const deriveWorkflowGroupStatistics = (
  group: WorkflowPermissionGroup,
  definitions: ProcessDefinition[],
  tasks: WorkflowTask[],
): WorkflowPermissionGroup => {
  const processes = definitions.flatMap((definition) => {
    const referenced = definition.versions.some((version) =>
      version.basic.starterGroups.some((value) => referencesGroup(value, group))
      || version.basic.closeGroups.some((value) => referencesGroup(value, group))
      || (version.basic.assigneeGroups ?? []).some((value) => referencesGroup(value, group))
      || version.snapshot.flow.nodes.some((node) =>
        referencesGroup(node.data?.permissionGroup, group)
        || (node.data?.permissionGroups ?? []).some((value) => referencesGroup(value, group)),
      ),
    );
    return referenced ? [definition.name] : [];
  });
  const uniqueProcesses = [...new Set(processes)];
  const openTasks = tasks.filter((task) =>
    task.status === "待处理" && referencesGroup(task.permissionGroupId, group),
  ).length;
  return {
    ...group,
    processes: uniqueProcesses,
    referenced: uniqueProcesses.length > 0,
    openTasks,
  };
};

export const deriveAllWorkflowGroupStatistics = (
  groups: WorkflowPermissionGroup[],
  definitions: ProcessDefinition[],
  tasks: WorkflowTask[],
) => groups.map((group) => deriveWorkflowGroupStatistics(group, definitions, tasks));
