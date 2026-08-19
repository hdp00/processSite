import { create } from "zustand";
import { persist } from "zustand/middleware";

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

export const initialDepartments: DepartmentRecord[] = [
  { key: "rd", name: "研发", path: "研发", level: 1, sort: 10, status: "启用", users: 72, referenced: true, description: "负责产品设计、软件与硬件开发。" },
  { key: "rd-software", name: "软件", path: "研发 / 软件", level: 2, parentKey: "rd", sort: 10, status: "启用", users: 36, referenced: true, description: "嵌入式与平台软件开发。" },
  { key: "rd-hardware", name: "硬件", path: "研发 / 硬件", level: 2, parentKey: "rd", sort: 20, status: "启用", users: 24, referenced: true, description: "电路、结构及器件设计。" },
  { key: "rd-test", name: "测试", path: "研发 / 测试", level: 2, parentKey: "rd", sort: 30, status: "启用", users: 12, referenced: false, description: "研发验证与系统测试。" },
  { key: "quality", name: "质量", path: "质量", level: 1, sort: 20, status: "启用", users: 41, referenced: true, description: "质量体系、检验与持续改进。" },
  { key: "quality-system", name: "体系", path: "质量 / 体系", level: 2, parentKey: "quality", sort: 10, status: "启用", users: 15, referenced: true, description: "质量体系文件与内审。" },
  { key: "quality-iqc", name: "来料检验", path: "质量 / 来料检验", level: 2, parentKey: "quality", sort: 20, status: "启用", users: 26, referenced: true, description: "供应商来料检验。" },
  { key: "production", name: "生产", path: "生产", level: 1, sort: 30, status: "启用", users: 108, referenced: true, description: "生产计划与现场执行。" },
  { key: "document", name: "文控", path: "文控", level: 1, sort: 40, status: "启用", users: 8, referenced: true, description: "受控文件发布与流程发起。" },
];

export const initialJobTitles: JobTitleRecord[] = [
  { id: "JOB-001", name: "经理", sort: 10, status: "启用", users: 55, description: "部门或业务管理岗位。" },
  { id: "JOB-002", name: "员工", sort: 20, status: "启用", users: 184, description: "普通业务执行岗位。" },
];

const applyUpdater = <T,>(current: T[], updater: CollectionUpdater<T>) =>
  typeof updater === "function" ? updater(current) : updater;

const rebuildDepartmentPaths = (departments: DepartmentRecord[]) => departments.map((department) => {
  if (!department.parentKey) return { ...department, path: department.name };
  const parent = departments.find((item) => item.key === department.parentKey);
  return { ...department, path: parent ? `${parent.name} / ${department.name}` : department.name };
});

export const useOrganizationStore = create<OrganizationState>()(
  persist(
    (set) => ({
      departments: initialDepartments,
      jobTitles: initialJobTitles,
      setDepartments: (updater) => set((state) => ({ departments: rebuildDepartmentPaths(applyUpdater(state.departments, updater)) })),
      setJobTitles: (updater) => set((state) => ({ jobTitles: applyUpdater(state.jobTitles, updater) })),
      resetOrganization: () => set({ departments: initialDepartments, jobTitles: initialJobTitles }),
    }),
    {
      name: "flowpilot-organization-domain-v1",
      version: 1,
    },
  ),
);

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

