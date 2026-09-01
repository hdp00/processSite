import { create } from "zustand";

export type OrganizationStatus = "启用" | "停用";

export interface DepartmentRecord {
  key: string;
  name: string;
  path: string;
  level: 1 | 2;
  parentKey?: string;
  sort: number;
  status: OrganizationStatus;
  users: number;
  referenced: boolean;
  description: string;
}

export interface JobTitleRecord {
  id: string;
  name: string;
  sort: number;
  status: OrganizationStatus;
  users: number;
  description: string;
}

type CollectionUpdater<T> = T[] | ((current: T[]) => T[]);

interface OrganizationState {
  departments: DepartmentRecord[];
  jobTitles: JobTitleRecord[];
  setDepartments: (updater: CollectionUpdater<DepartmentRecord>) => void;
  setJobTitles: (updater: CollectionUpdater<JobTitleRecord>) => void;
  resetOrganization: () => void;
}

const applyUpdater = <T,>(current: T[], updater: CollectionUpdater<T>) =>
  typeof updater === "function" ? updater(current) : updater;

const rebuildDepartmentPaths = (departments: DepartmentRecord[]) => departments.map((department) => {
  if (!department.parentKey) return { ...department, path: department.name };
  const parent = departments.find((item) => item.key === department.parentKey);
  return { ...department, path: parent ? `${parent.name} / ${department.name}` : department.name };
});

export const useOrganizationStore = create<OrganizationState>()((set) => ({
  departments: [],
  jobTitles: [],
  setDepartments: (updater) => set((state) => ({
    departments: rebuildDepartmentPaths(applyUpdater(state.departments, updater)),
  })),
  setJobTitles: (updater) => set((state) => ({ jobTitles: applyUpdater(state.jobTitles, updater) })),
  resetOrganization: () => set({ departments: [], jobTitles: [] }),
}));

export const departmentCascaderOptions = (departments: DepartmentRecord[]) => departments
  .filter((department) => department.level === 1 && department.status === "启用")
  .sort((left, right) => left.sort - right.sort)
  .map((department) => ({
    value: department.key,
    label: department.name,
    children: departments
      .filter((child) => child.parentKey === department.key && child.status === "启用")
      .sort((left, right) => left.sort - right.sort)
      .map((child) => ({ value: child.key, label: child.name })),
  }));

export const departmentCascaderValue = (departmentIds: string[], departments: DepartmentRecord[]) => {
  const departmentId = departmentIds.at(-1);
  if (!departmentId) return [];
  const department = departments.find((item) => item.key === departmentId);
  return department?.parentKey ? [department.parentKey, departmentId] : [departmentId];
};
