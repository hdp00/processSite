import {
  ApartmentOutlined,
  AuditOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FileSearchOutlined,
  KeyOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  StopOutlined,
  TeamOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Avatar,
  Button,
  Card,
  Cascader,
  Checkbox,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Tree,
  Typography,
  message,
  type TableProps,
} from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useBeforeUnload, useBlocker, useNavigate, useSearchParams } from "react-router-dom";
import { StatusPill } from "../components/StatusPill";
import {
  ROLE_PERMISSION_STORAGE_KEY,
  normalizeRolePermissionList,
  notifyRolePermissionsChanged,
} from "../state/rolePermissions";
import "./governance-pages.css";

type EnableStatus = "启用" | "停用";
type JobTitle = string;

interface JobTitleRecord {
  id: string;
  name: string;
  sort: number;
  status: EnableStatus;
  users: number;
  description: string;
}

const JOB_TITLE_STORAGE_KEY = "flowpilot-governance-job-titles-v1";
const JOB_TITLES_CHANGED_EVENT = "flowpilot-job-titles-changed";
const initialJobTitles: JobTitleRecord[] = [
  { id: "JOB-001", name: "经理", sort: 10, status: "启用", users: 55, description: "部门或业务管理岗位。" },
  { id: "JOB-002", name: "员工", sort: 20, status: "启用", users: 184, description: "普通业务执行岗位。" },
];

function readJobTitles() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(JOB_TITLE_STORAGE_KEY) ?? "null") as JobTitleRecord[] | null;
    return Array.isArray(saved) && saved.length ? saved : initialJobTitles;
  } catch {
    return initialJobTitles;
  }
}

function writeJobTitles(value: JobTitleRecord[]) {
  window.localStorage.setItem(JOB_TITLE_STORAGE_KEY, JSON.stringify(value));
  window.dispatchEvent(new Event(JOB_TITLES_CHANGED_EVENT));
}

const departmentOptions = [
  {
    value: "rd",
    label: "研发",
    children: [
      { value: "rd-software", label: "软件" },
      { value: "rd-hardware", label: "硬件" },
      { value: "rd-test", label: "测试" },
    ],
  },
  {
    value: "quality",
    label: "质量",
    children: [
      { value: "quality-system", label: "体系" },
      { value: "quality-iqc", label: "来料检验" },
    ],
  },
  {
    value: "production",
    label: "生产",
    children: [
      { value: "production-line1", label: "一车间" },
      { value: "production-line2", label: "二车间" },
    ],
  },
  { value: "document", label: "文控" },
];

const roleOptions = ["超级管理员", "系统管理员", "流程管理员", "文控专员", "研发审核员", "质量审核员", "生产审核员", "只读观察员"];
const assignableRoleOptions = roleOptions.filter((role) => role !== "超级管理员");
const peopleNames = [
  "王敏", "张伟", "林晓", "赵磊", "陈晨", "刘洋", "周宁", "孙悦", "吴昊", "徐洁", "杨帆", "胡静",
  "高远", "许诺", "郑宇", "唐薇", "韩松", "曹颖", "冯浩", "邓琳", "蒋峰", "沈佳", "袁博", "程雪",
];

const departmentByIndex = [
  { value: ["rd", "rd-software"], path: "研发 / 软件" },
  { value: ["rd", "rd-hardware"], path: "研发 / 硬件" },
  { value: ["rd", "rd-test"], path: "研发 / 测试" },
  { value: ["quality", "quality-system"], path: "质量 / 体系" },
  { value: ["quality", "quality-iqc"], path: "质量 / 来料检验" },
  { value: ["production", "production-line1"], path: "生产 / 一车间" },
  { value: ["production", "production-line2"], path: "生产 / 二车间" },
  { value: ["rd"], path: "研发" },
  { value: ["quality"], path: "质量" },
  { value: ["document"], path: "文控" },
];

interface UserRecord {
  id: string;
  account: string;
  name: string;
  department: string[];
  departmentPath: string;
  jobTitle: JobTitle;
  roles: string[];
  status: EnableStatus;
  lastLogin: string;
  builtIn?: boolean;
}

function makeUsers(): UserRecord[] {
  const configuredJobTitles = readJobTitles();
  const managerTitle = configuredJobTitles.find((item) => item.id === "JOB-001")?.name ?? "经理";
  const employeeTitle = configuredJobTitles.find((item) => item.id === "JOB-002")?.name
    ?? configuredJobTitles.find((item) => item.status === "启用")?.name
    ?? "员工";
  const regularUsers: UserRecord[] = Array.from({ length: 238 }, (_, index) => {
    const department = departmentByIndex[index % departmentByIndex.length];
    const name = peopleNames[index % peopleNames.length] + (index >= peopleNames.length ? String(Math.floor(index / peopleNames.length) + 1) : "");
    const primaryRole = index % 11 === 0 ? "流程管理员" : index % 5 === 0 ? "质量审核员" : index % 3 === 0 ? "研发审核员" : "只读观察员";
    return {
      id: `USR-${String(index + 1).padStart(4, "0")}`,
      account: `user${String(index + 1).padStart(3, "0")}`,
      name,
      department: department.value,
      departmentPath: department.path,
      jobTitle: index % 13 === 0 || department.value.length === 1 ? managerTitle : employeeTitle,
      roles: index % 17 === 0 ? [primaryRole, "文控专员"] : [primaryRole],
      status: index % 19 === 0 ? "停用" : "启用",
      lastLogin: index % 9 === 0 ? "从未登录" : `2026-08-${String(13 - (index % 8)).padStart(2, "0")} ${String(8 + (index % 10)).padStart(2, "0")}:26`,
    };
  });
  return [
    {
      id: "USR-0000",
      account: "superadmin",
      name: "超级管理员",
      department: ["system"],
      departmentPath: "系统内置",
      jobTitle: managerTitle,
      roles: ["超级管理员"],
      status: "启用",
      lastLogin: "演示身份可直接切换",
      builtIn: true,
    },
    ...regularUsers,
  ];
}

function StatusTag({ status }: { status: EnableStatus }) {
  return <StatusPill status={status} />;
}

function PersonChip({ name, detail }: { name: string; detail?: string }) {
  return (
    <span className="gov-person-chip">
      <Avatar size={30}>{name.slice(-1)}</Avatar>
      <span><strong>{name}</strong>{detail ? <small>{detail}</small> : null}</span>
    </span>
  );
}

function ResultHeader({ title, count, extra }: { title: string; count: number | string; extra?: React.ReactNode }) {
  return (
    <div className="gov-result-head">
      <div><strong>{title}</strong><Tag bordered={false}>{count} 条</Tag></div>
      {extra ? <div className="gov-result-extra">{extra}</div> : null}
    </div>
  );
}

function SummaryStrip({ items }: { items: Array<{ label: string; value: string | number; note: string; tone?: string }> }) {
  return (
    <div className="gov-summary-strip">
      {items.map((item) => (
        <div className={`gov-summary-item ${item.tone ? `is-${item.tone}` : ""}`} key={item.label}>
          <span>{item.label}</span><strong>{item.value}</strong><small>{item.note}</small>
        </div>
      ))}
    </div>
  );
}

export function UserManagementPage() {
  const [users, setUsers] = useState(makeUsers);
  const [jobTitles, setJobTitles] = useState(readJobTitles);
  const [draftFilters, setDraftFilters] = useState({ keyword: "", department: [] as string[], jobTitle: "", role: "", status: "" });
  const [filters, setFilters] = useState(draftFilters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [drawerUser, setDrawerUser] = useState<UserRecord | "new" | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    const refreshJobTitles = () => setJobTitles(readJobTitles());
    window.addEventListener(JOB_TITLES_CHANGED_EVENT, refreshJobTitles);
    return () => window.removeEventListener(JOB_TITLES_CHANGED_EVENT, refreshJobTitles);
  }, []);

  const activeJobTitles = jobTitles.filter((item) => item.status === "启用").sort((a, b) => a.sort - b.sort);
  const managerTitleName = jobTitles.find((item) => item.id === "JOB-001")?.name;
  const drawerJobTitle = drawerUser !== "new" ? drawerUser?.jobTitle : undefined;
  const selectableJobTitles = jobTitles
    .filter((item) => item.status === "启用" || item.name === drawerJobTitle)
    .sort((a, b) => a.sort - b.sort);

  const filtered = useMemo(() => users.filter((user) => {
    const keyword = filters.keyword.trim().toLowerCase();
    const matchesKeyword = !keyword || `${user.account}${user.name}`.toLowerCase().includes(keyword);
    const matchesDepartment = !filters.department.length || filters.department.every((value, index) => user.department[index] === value);
    return matchesKeyword && matchesDepartment && (!filters.jobTitle || user.jobTitle === filters.jobTitle)
      && (!filters.role || user.roles.includes(filters.role)) && (!filters.status || user.status === filters.status);
  }), [filters, users]);
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);

  const openEditor = (user: UserRecord | "new") => {
    if (user !== "new" && user.builtIn) {
      message.info("超级管理员是系统内置账号，不允许修改");
      return;
    }
    setDrawerUser(user);
    form.resetFields();
    form.setFieldsValue(user === "new" ? {
      account: "", name: "", password: "", department: [], jobTitle: activeJobTitles.find((item) => item.id === "JOB-002")?.name ?? activeJobTitles[0]?.name, roles: [], status: true,
    } : { ...user });
  };

  const columns: TableProps<UserRecord>["columns"] = [
    { title: "用户", dataIndex: "name", width: 190, fixed: "left", render: (_, record) => <Space size={6}><PersonChip name={record.name} detail={record.account} />{record.builtIn ? <Tag color="gold" icon={<LockOutlined />}>内置</Tag> : null}</Space> },
    { title: "部门", dataIndex: "departmentPath", width: 160, ellipsis: true },
    { title: "职务", dataIndex: "jobTitle", width: 100, render: (value: JobTitle) => <Tag color={value === managerTitleName ? "purple" : "default"}>{value}</Tag> },
    { title: "角色（可多选）", dataIndex: "roles", width: 260, render: (roles: string[]) => <Space size={[4, 4]} wrap>{roles.map((role) => <Tag key={role} color={role === "超级管理员" ? "gold" : role === "流程管理员" ? "blue" : undefined}>{role}</Tag>)}</Space> },
    { title: "状态", dataIndex: "status", width: 88, render: (status: EnableStatus) => <StatusTag status={status} /> },
    { title: "最近登录", dataIndex: "lastLogin", width: 154 },
    {
      title: "操作", fixed: "right", width: 146, align: "center",
      render: (_, record) => (
        <Space size={4}>
          <Tooltip title={record.builtIn ? "系统内置账号不可编辑" : "编辑用户"}><Button disabled={record.builtIn} type="text" aria-label={`编辑用户：${record.name}`} icon={<EditOutlined />} onClick={() => openEditor(record)} /></Tooltip>
          <Tooltip title={record.status === "启用" ? "停用账号" : "启用账号"}>
            <Popconfirm disabled={record.builtIn} title={`确认${record.status === "启用" ? "停用" : "启用"} ${record.name}？`} onConfirm={() => {
              setUsers((rows) => rows.map((item) => item.id === record.id ? { ...item, status: item.status === "启用" ? "停用" : "启用" } : item));
              message.success(`账号已${record.status === "启用" ? "停用" : "启用"}`);
            }}><Button disabled={record.builtIn} type="text" aria-label={`${record.status === "启用" ? "停用" : "启用"}用户：${record.name}`} icon={record.status === "启用" ? <StopOutlined /> : <CheckCircleOutlined />} /></Popconfirm>
          </Tooltip>
          <Tooltip title={record.builtIn ? "系统内置账号密码不可在此重置" : "重置密码"}><Popconfirm disabled={record.builtIn} title="生成临时密码并立即生效？" onConfirm={() => message.success(`已为 ${record.name} 重置密码：a`)}><Button disabled={record.builtIn} type="text" aria-label={`重置密码：${record.name}`} icon={<KeyOutlined />} /></Popconfirm></Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div className="page-stack gov-page">
      <SummaryStrip items={[
        { label: "用户总数", value: users.length, note: "按服务端分页加载" },
        { label: "启用账号", value: users.filter((item) => item.status === "启用").length, note: "可正常登录", tone: "green" },
        { label: "多角色用户", value: users.filter((item) => item.roles.length > 1).length, note: "权限取角色并集", tone: "blue" },
        { label: "一级部门用户", value: users.filter((item) => item.department.length === 1).length, note: "允许归属一级节点" },
      ]} />
      <Card className="query-card gov-query-card">
        <div className="gov-filter-grid gov-filter-grid--users">
          <label><span>关键词</span><Input allowClear prefix={<SearchOutlined />} placeholder="登录账号或员工姓名" value={draftFilters.keyword} onChange={(event) => setDraftFilters({ ...draftFilters, keyword: event.target.value })} /></label>
          <label><span>部门</span><Cascader changeOnSelect allowClear options={departmentOptions} placeholder="一级或二级部门" value={draftFilters.department} onChange={(value) => setDraftFilters({ ...draftFilters, department: value.map(String) })} /></label>
          <label><span>职务</span><Select allowClear placeholder="全部职务" value={draftFilters.jobTitle || undefined} options={[...jobTitles].sort((a, b) => a.sort - b.sort).map((item) => ({ value: item.name, label: item.status === "停用" ? `${item.name}（已停用）` : item.name }))} onChange={(value) => setDraftFilters({ ...draftFilters, jobTitle: value ?? "" })} /></label>
          <label><span>角色</span><Select showSearch allowClear placeholder="全部角色" value={draftFilters.role || undefined} options={roleOptions.map((value) => ({ value }))} onChange={(value) => setDraftFilters({ ...draftFilters, role: value ?? "" })} /></label>
          <label><span>状态</span><Select allowClear placeholder="全部状态" value={draftFilters.status || undefined} options={["启用", "停用"].map((value) => ({ value }))} onChange={(value) => setDraftFilters({ ...draftFilters, status: value ?? "" })} /></label>
          <div className="gov-filter-actions"><Button type="primary" icon={<SearchOutlined />} onClick={() => { setFilters(draftFilters); setPage(1); }}>查询</Button><Button icon={<ReloadOutlined />} onClick={() => { const empty = { keyword: "", department: [], jobTitle: "", role: "", status: "" }; setDraftFilters(empty); setFilters(empty); setPage(1); }}>重置</Button></div>
        </div>
      </Card>
      <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}>
        <ResultHeader title="用户列表" count={filtered.length} extra={<><Typography.Text type="secondary">仅加载当前页数据</Typography.Text><Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor("new")}>新增用户</Button></>} />
        <Table<UserRecord> rowKey="id" columns={columns} dataSource={pageRows} scroll={{ x: 1080 }} pagination={{ current: page, pageSize, total: filtered.length, showSizeChanger: true, pageSizeOptions: [10, 20, 50], showTotal: (total) => `共 ${total} 名用户`, onChange: (nextPage, nextPageSize) => { setPage(nextPageSize === pageSize ? nextPage : 1); setPageSize(nextPageSize); } }} />
      </Card>
      <Drawer width={600} open={drawerUser !== null} onClose={() => setDrawerUser(null)} title={drawerUser === "new" ? "新增用户" : "编辑用户"} extra={<Space><Button onClick={() => setDrawerUser(null)}>取消</Button><Button type="primary" onClick={() => form.submit()}>保存</Button></Space>}>
        <Alert
          className="gov-drawer-alert"
          type="info"
          showIcon
          message={drawerUser === "new" ? "部门、职务与角色相互独立" : "密码和账号状态使用列表操作维护"}
          description={drawerUser === "new" ? "经理职务不会自动获得管理权限；一个用户可拥有多个角色，最终权限取角色权限并集。" : "编辑页只维护用户基本资料、部门、职务和角色；密码通过“重置密码”处理，账号状态通过启用/停用操作处理。"}
        />
        <Form form={form} layout="vertical" requiredMark="optional" onFinish={(values) => {
          const path = values.department.length === 1 ? departmentOptions.find((item) => item.value === values.department[0])?.label : `${departmentOptions.find((item) => item.value === values.department[0])?.label} / ${departmentOptions.find((item) => item.value === values.department[0])?.children?.find((item) => item.value === values.department[1])?.label}`;
          if (drawerUser === "new") {
            const created: UserRecord = { id: `USR-${String(users.length + 1).padStart(4, "0")}`, account: values.account, name: values.name, department: values.department, departmentPath: String(path), jobTitle: values.jobTitle, roles: values.roles, status: values.status ? "启用" : "停用", lastLogin: "从未登录" };
            setUsers((rows) => [created, ...rows]);
            message.success("用户已创建");
          } else if (drawerUser) {
            setUsers((rows) => rows.map((item) => item.id === drawerUser.id ? { ...item, account: values.account, name: values.name, department: values.department, departmentPath: String(path), jobTitle: values.jobTitle, roles: values.roles } : item));
            message.success("用户信息已保存");
          }
          setDrawerUser(null);
        }}>
          <div className="gov-form-grid">
            <Form.Item name="account" label="登录账号" rules={[{ required: true, message: "请输入登录账号" }, { validator: (_, value) => String(value ?? "").trim().toLowerCase() === "superadmin" ? Promise.reject(new Error("该账号由系统内置，不能创建或修改")) : Promise.resolve() }]}><Input maxLength={40} /></Form.Item>
            <Form.Item name="name" label="员工姓名" rules={[{ required: true, message: "请输入员工姓名" }]}><Input maxLength={40} /></Form.Item>
          </div>
          {drawerUser === "new" && <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 1, message: "密码至少 1 个字符" }]} extra="首版采用最低密码强度，允许单个字符；无首次登录改密和连续失败锁定。"><Input.Password maxLength={64} /></Form.Item>}
          <Form.Item name="department" label="所属部门" rules={[{ required: true, message: "请选择部门" }]} extra="可选择一级节点（如研发）或二级节点（如研发 / 软件）。"><Cascader changeOnSelect showSearch options={departmentOptions} placeholder="请选择一级或二级部门" /></Form.Item>
          {drawerUser === "new" ? <div className="gov-form-grid">
            <Form.Item name="jobTitle" label="职务" rules={[{ required: true }]}><Select options={selectableJobTitles.map((item) => ({ value: item.name, label: item.status === "停用" ? `${item.name}（已停用，仅保留历史）` : item.name }))} /></Form.Item>
            <Form.Item name="status" label="初始账号状态" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="停用" /></Form.Item>
          </div> : <Form.Item name="jobTitle" label="职务" rules={[{ required: true }]}><Select options={selectableJobTitles.map((item) => ({ value: item.name, label: item.status === "停用" ? `${item.name}（已停用，仅保留历史）` : item.name }))} /></Form.Item>}
          <Form.Item name="roles" label="系统角色" rules={[{ required: true, message: "至少选择一个角色" }]} extra="超级管理员为唯一系统内置账号，不能分配给其他用户。"><Select mode="multiple" showSearch optionFilterProp="label" maxTagCount="responsive" options={assignableRoleOptions.map((value) => ({ value, label: value }))} /></Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}

interface DepartmentRecord {
  key: string;
  name: string;
  path: string;
  level: 1 | 2;
  parentKey?: string;
  sort: number;
  status: EnableStatus;
  users: number;
  referenced: boolean;
  description: string;
}

const initialDepartments: DepartmentRecord[] = [
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

export function DepartmentManagementPage() {
  const [section, setSection] = useState<"departments" | "jobTitles">("departments");
  const [departments, setDepartments] = useState(initialDepartments);
  const [jobTitles, setJobTitles] = useState(readJobTitles);
  const [selectedKey, setSelectedKey] = useState("rd");
  const [editor, setEditor] = useState<{ mode: "new-root" | "new-child" | "edit"; record?: DepartmentRecord } | null>(null);
  const [jobTitleEditor, setJobTitleEditor] = useState<JobTitleRecord | "new" | null>(null);
  const [form] = Form.useForm();
  const [jobTitleForm] = Form.useForm();

  useEffect(() => {
    writeJobTitles(jobTitles);
  }, [jobTitles]);
  const selected = departments.find((item) => item.key === selectedKey) ?? departments[0];
  const treeData = departments.filter((item) => item.level === 1).sort((a, b) => a.sort - b.sort).map((root) => ({
    key: root.key,
    title: <span className="gov-tree-title"><span>{root.name}</span><Tag bordered={false}>{root.users} 人</Tag>{root.status === "停用" ? <StatusPill status="停用" compact /> : null}</span>,
    children: departments.filter((item) => item.parentKey === root.key).sort((a, b) => a.sort - b.sort).map((child) => ({ key: child.key, title: <span className="gov-tree-title"><span>{child.name}</span><Tag bordered={false}>{child.users} 人</Tag>{child.status === "停用" ? <StatusPill status="停用" compact /> : null}</span> })),
  }));
  const openDepartmentEditor = (mode: "new-root" | "new-child" | "edit") => {
    const record = mode === "edit" ? selected : undefined;
    setEditor({ mode, record });
    form.setFieldsValue(record ? { ...record, status: record.status === "启用" } : { name: "", sort: 10, status: true, description: "" });
  };
  const openJobTitleEditor = (record: JobTitleRecord | "new") => {
    setJobTitleEditor(record);
    jobTitleForm.resetFields();
    jobTitleForm.setFieldsValue(record === "new"
      ? { name: "", sort: Math.max(0, ...jobTitles.map((item) => item.sort)) + 10, status: true, description: "" }
      : { ...record, status: record.status === "启用" });
  };
  const jobTitleColumns: TableProps<JobTitleRecord>["columns"] = [
    { title: "职务名称", dataIndex: "name", width: 190, fixed: "left", render: (value: string) => <strong>{value}</strong> },
    { title: "使用用户", dataIndex: "users", width: 110, render: (value: number) => value ? <Tag color="blue">{value} 人</Tag> : <Tag>未使用</Tag> },
    { title: "显示排序", dataIndex: "sort", width: 100 },
    { title: "状态", dataIndex: "status", width: 90, render: (value: EnableStatus) => <StatusTag status={value} /> },
    { title: "说明", dataIndex: "description", ellipsis: true },
    {
      title: "操作",
      key: "actions",
      width: 142,
      fixed: "right",
      align: "center",
      render: (_, record) => <Space size={4}>
        <Tooltip title="编辑职务"><Button type="text" aria-label={`编辑职务：${record.name}`} icon={<EditOutlined />} onClick={() => openJobTitleEditor(record)} /></Tooltip>
        <Tooltip title={record.status === "启用" ? "停用职务" : "启用职务"}><Button type="text" aria-label={`${record.status === "启用" ? "停用" : "启用"}职务：${record.name}`} icon={record.status === "启用" ? <StopOutlined /> : <CheckCircleOutlined />} onClick={() => { setJobTitles((rows) => rows.map((item) => item.id === record.id ? { ...item, status: item.status === "启用" ? "停用" : "启用" } : item)); message.success(`职务已${record.status === "启用" ? "停用" : "启用"}`); }} /></Tooltip>
        <Tooltip title={record.users ? "已有用户使用，不能删除" : "删除职务"}><Popconfirm disabled={record.users > 0} title="确认删除这个职务？" onConfirm={() => { setJobTitles((rows) => rows.filter((item) => item.id !== record.id)); message.success("职务已删除"); }}><Button type="text" danger disabled={record.users > 0} icon={<DeleteOutlined />} /></Popconfirm></Tooltip>
      </Space>,
    },
  ];

  return (
    <div className="page-stack gov-page">
      <Card className="gov-org-section-switch" bordered={false}>
        <Segmented
          className="app-mode-segmented gov-org-tabs"
          block
          value={section}
          onChange={(value) => { setSection(value as "departments" | "jobTitles"); setEditor(null); setJobTitleEditor(null); }}
          options={[
            { label: <span><ApartmentOutlined /> 部门架构</span>, value: "departments" },
            { label: <span><TeamOutlined /> 职务管理</span>, value: "jobTitles" },
          ]}
        />
      </Card>
      {section === "departments" ? <>
      <Alert showIcon type="info" message="部门层级最多两级" description="用户可以归属一级或二级部门。一级部门可以没有子部门；二级部门不能继续添加下级。引用中的部门不可删除，但可以停用。" />
      <div className="gov-split-layout gov-department-layout">
        <Card className="content-card gov-tree-card" title={<Space><ApartmentOutlined />组织架构</Space>} extra={<Button type="text" icon={<PlusOutlined />} onClick={() => openDepartmentEditor("new-root")}>新增一级部门</Button>}>
          <Input allowClear prefix={<SearchOutlined />} placeholder="搜索部门" className="gov-tree-search" />
          <Tree blockNode defaultExpandAll selectedKeys={[selectedKey]} treeData={treeData} onSelect={(keys) => keys[0] && setSelectedKey(String(keys[0]))} />
        </Card>
        <Card className="content-card gov-detail-card" title="部门详情" extra={<Space><Button icon={<EditOutlined />} onClick={() => openDepartmentEditor("edit")}>编辑</Button><Button type="primary" icon={<PlusOutlined />} disabled={selected.level === 2} onClick={() => openDepartmentEditor("new-child")}>添加下级</Button></Space>}>
          <div className="gov-detail-hero-row"><span className="gov-detail-icon"><ApartmentOutlined /></span><div><Typography.Title level={4}>{selected.name}</Typography.Title><Typography.Text type="secondary">完整路径：{selected.path}</Typography.Text></div><StatusTag status={selected.status} /></div>
          <Descriptions bordered column={2} size="middle" items={[
            { key: "level", label: "部门层级", children: `${selected.level} 级` },
            { key: "sort", label: "显示排序", children: selected.sort },
            { key: "users", label: "直属用户", children: `${selected.users} 人` },
            { key: "reference", label: "引用状态", children: selected.referenced ? <Tag color="blue">已被引用</Tag> : <Tag>未引用</Tag> },
            { key: "description", label: "说明", span: 2, children: selected.description || "—" },
          ]} />
          <div className="gov-detail-section">
            <div className="gov-section-title">维护规则</div>
            <Alert type={selected.referenced ? "warning" : "success"} showIcon message={selected.referenced ? "该部门已有用户或历史流程引用，不允许删除" : "当前部门尚未被引用，可以删除"} description="停用后不能再分配给新用户；现有用户与历史数据仍保留该部门路径，待管理员完成迁移。" />
            <Space>
              <Popconfirm title={`确认${selected.status === "启用" ? "停用" : "启用"}此部门？`} onConfirm={() => { setDepartments((rows) => rows.map((item) => item.key === selected.key ? { ...item, status: item.status === "启用" ? "停用" : "启用" } : item)); message.success(`部门已${selected.status === "启用" ? "停用" : "启用"}`); }}><Button icon={selected.status === "启用" ? <StopOutlined /> : <CheckCircleOutlined />}>{selected.status === "启用" ? "停用部门" : "启用部门"}</Button></Popconfirm>
              <Popconfirm disabled={selected.referenced} title="确认删除此部门？" onConfirm={() => { setDepartments((rows) => rows.filter((item) => item.key !== selected.key)); setSelectedKey("rd"); message.success("未引用部门已删除"); }}><Button danger disabled={selected.referenced} icon={<DeleteOutlined />}>删除部门</Button></Popconfirm>
            </Space>
          </div>
        </Card>
      </div>
      </> : <>
        <Alert showIcon type="info" message="职务是全局组织字典" description="职务不绑定具体部门。停用后不能再分配给新用户，已有用户保留历史职务；只有未被任何用户使用的职务才可以删除。" />
        <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}>
          <ResultHeader title="职务列表" count={jobTitles.length} extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => openJobTitleEditor("new")}>新增职务</Button>} />
          <Table<JobTitleRecord> rowKey="id" columns={jobTitleColumns} dataSource={[...jobTitles].sort((a, b) => a.sort - b.sort)} scroll={{ x: 850 }} pagination={false} />
        </Card>
      </>}
      <Drawer width={520} open={section === "departments" && editor !== null} onClose={() => setEditor(null)} title={editor?.mode === "edit" ? "编辑部门" : editor?.mode === "new-child" ? `在“${selected.name}”下新增二级部门` : "新增一级部门"} extra={<Space><Button onClick={() => setEditor(null)}>取消</Button><Button type="primary" onClick={() => form.submit()}>保存</Button></Space>}>
        {editor?.mode === "new-child" && selected.level === 2 ? <Alert type="error" showIcon message="二级部门不能继续添加下级" /> : null}
        <Form form={form} layout="vertical" onFinish={(values) => {
          if (editor?.mode === "edit") {
            setDepartments((rows) => rows.map((item) => item.key === selected.key ? { ...item, name: values.name, path: item.parentKey ? `${rows.find((parent) => parent.key === item.parentKey)?.name} / ${values.name}` : values.name, sort: values.sort, status: values.status ? "启用" : "停用", description: values.description } : item));
            message.success("部门信息已保存");
          } else {
            const isChild = editor?.mode === "new-child";
            const key = `dept-${Date.now()}`;
            setDepartments((rows) => [...rows, { key, name: values.name, path: isChild ? `${selected.name} / ${values.name}` : values.name, level: isChild ? 2 : 1, parentKey: isChild ? selected.key : undefined, sort: values.sort, status: values.status ? "启用" : "停用", users: 0, referenced: false, description: values.description }]);
            setSelectedKey(key);
            message.success("部门已创建");
          }
          setEditor(null);
        }}>
          <Form.Item name="name" label="部门名称" rules={[{ required: true, message: "请输入部门名称" }]}><Input maxLength={40} /></Form.Item>
          <Form.Item name="sort" label="显示排序" rules={[{ required: true }]}><InputNumber min={0} max={9999} style={{ width: "100%" }} /></Form.Item>
          <Form.Item name="status" label="状态" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="停用" /></Form.Item>
          <Form.Item name="description" label="部门说明"><Input.TextArea rows={4} maxLength={200} showCount /></Form.Item>
        </Form>
      </Drawer>
      <Drawer width={520} open={section === "jobTitles" && jobTitleEditor !== null} onClose={() => setJobTitleEditor(null)} title={jobTitleEditor === "new" ? "新增职务" : "编辑职务"} extra={<Space><Button onClick={() => setJobTitleEditor(null)}>取消</Button><Button type="primary" onClick={() => jobTitleForm.submit()}>保存</Button></Space>}>
        {jobTitleEditor !== "new" && jobTitleEditor?.users ? <Alert className="gov-drawer-alert" type="info" showIcon message={`当前有 ${jobTitleEditor.users} 名用户使用该职务`} description="可以修改名称、排序、状态和说明；名称修改后所有关联用户同步显示新名称，但该职务不能直接删除。" /> : null}
        <Form form={jobTitleForm} layout="vertical" onFinish={(values) => {
          if (jobTitleEditor === "new") {
            const sequence = Math.max(0, ...jobTitles.map((item) => Number(item.id.match(/\d+$/)?.[0] ?? 0))) + 1;
            setJobTitles((rows) => [...rows, { id: `JOB-${String(sequence).padStart(3, "0")}`, name: values.name.trim(), sort: values.sort, status: values.status ? "启用" : "停用", users: 0, description: values.description }]);
            message.success("职务已新增");
          } else if (jobTitleEditor) {
            setJobTitles((rows) => rows.map((item) => item.id === jobTitleEditor.id ? { ...item, name: values.name.trim(), sort: values.sort, status: values.status ? "启用" : "停用", description: values.description } : item));
            message.success("职务信息已保存");
          }
          setJobTitleEditor(null);
        }}>
          <Form.Item name="name" label="职务名称" rules={[
            { required: true, whitespace: true, message: "请输入职务名称" },
            { validator: (_, value) => { const name = String(value ?? "").trim(); const currentId = jobTitleEditor !== "new" ? jobTitleEditor?.id : undefined; return jobTitles.some((item) => item.id !== currentId && item.name.trim() === name) ? Promise.reject(new Error("职务名称已存在")) : Promise.resolve(); } },
          ]}><Input maxLength={40} showCount /></Form.Item>
          <Form.Item name="sort" label="显示排序" rules={[{ required: true }]}><InputNumber min={0} max={9999} style={{ width: "100%" }} /></Form.Item>
          <Form.Item name="status" label="状态" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="停用" /></Form.Item>
          <Form.Item name="description" label="职务说明"><Input.TextArea rows={4} maxLength={200} showCount /></Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}

interface RoleRecord { id: string; name: string; code: string; description: string; pagePermissions: number; actionPermissions: number; users: number; status: EnableStatus; members: string[]; builtIn?: boolean; }
const ROLE_STORAGE_KEY = "flowpilot-governance-roles-v1";
const superAdminRole: RoleRecord = {
  id: "ROLE-SUPER",
  name: "超级管理员",
  code: "super_admin",
  description: "系统内置最高权限角色；权限不可修改，不参与流程权限组成员计算。",
  pagePermissions: 11,
  actionPermissions: 37,
  users: 1,
  status: "启用",
  members: [],
  builtIn: true,
};
const initialRoles: RoleRecord[] = [
  superAdminRole,
  { id: "ROLE-001", name: "系统管理员", code: "system_admin", description: "维护用户、角色、权限及系统参数", pagePermissions: 19, actionPermissions: 43, users: 3, status: "启用", members: ["王敏", "林晓", "赵磊"] },
  { id: "ROLE-002", name: "流程管理员", code: "workflow_admin", description: "创建、配置、发布和停用流程", pagePermissions: 8, actionPermissions: 21, users: 7, status: "启用", members: ["王敏", "陈晨", "刘洋", "周宁", "孙悦", "吴昊", "徐洁"] },
  { id: "ROLE-003", name: "文控专员", code: "document_controller", description: "发起、重新发布与关闭受控文件流程", pagePermissions: 6, actionPermissions: 14, users: 12, status: "启用", members: peopleNames.slice(0, 12) },
  { id: "ROLE-004", name: "研发审核员", code: "rd_reviewer", description: "系统页面权限；具体流程处理资格由流程权限组决定", pagePermissions: 4, actionPermissions: 7, users: 64, status: "启用", members: peopleNames.slice(2, 14) },
  { id: "ROLE-005", name: "质量审核员", code: "quality_reviewer", description: "质量审核相关页面和动作权限", pagePermissions: 4, actionPermissions: 7, users: 35, status: "启用", members: peopleNames.slice(5, 17) },
  { id: "ROLE-006", name: "生产审核员", code: "production_reviewer", description: "生产审核相关页面和动作权限", pagePermissions: 4, actionPermissions: 7, users: 89, status: "启用", members: peopleNames.slice(8, 20) },
  { id: "ROLE-007", name: "只读观察员", code: "readonly_observer", description: "可查看被授权的流程，无处理权限", pagePermissions: 3, actionPermissions: 2, users: 28, status: "启用", members: peopleNames.slice(10, 22) },
];

function nextRoleIdentity(roles: RoleRecord[]) {
  const sequence = Math.max(0, ...roles.map((role) => Number(role.id.match(/\d+$/)?.[0] ?? 0))) + 1;
  return {
    id: `ROLE-${String(sequence).padStart(3, "0")}`,
    code: `role_${String(sequence).padStart(4, "0")}`,
  };
}

export function RoleManagementPage() {
  const navigate = useNavigate();
  const [roles, setRoles] = useState(loadRolesWithPermissionStats);
  const [keyword, setKeyword] = useState("");
  const [editor, setEditor] = useState<RoleRecord | "new" | null>(null);
  const [memberRole, setMemberRole] = useState<RoleRecord | null>(null);
  const [memberKeyword, setMemberKeyword] = useState("");
  const [editingMembers, setEditingMembers] = useState<string[]>([]);
  const [roleMemberKeyword, setRoleMemberKeyword] = useState("");
  const [roleMemberView, setRoleMemberView] = useState<"all" | "selected">("all");
  const [form] = Form.useForm();
  useEffect(() => {
    window.localStorage.setItem(ROLE_STORAGE_KEY, JSON.stringify(roles));
  }, [roles]);
  const filtered = roles.filter((role) => `${role.name}${role.description}`.toLowerCase().includes(keyword.toLowerCase()));
  const configuredRoleJobTitles = readJobTitles().filter((item) => item.status === "启用").sort((a, b) => a.sort - b.sort);
  const roleMemberCandidates = peopleNames.map((name, index) => ({
    name,
    department: departmentByIndex[index % departmentByIndex.length].path,
    jobTitle: configuredRoleJobTitles[index % Math.max(configuredRoleJobTitles.length, 1)]?.name ?? "未设置",
  }));
  const visibleRoleMembers = roleMemberCandidates.filter((member) => {
    const matchesView = roleMemberView === "all" || editingMembers.includes(member.name);
    const normalizedKeyword = roleMemberKeyword.trim().toLowerCase();
    return matchesView && (!normalizedKeyword || `${member.name}${member.department}${member.jobTitle}`.toLowerCase().includes(normalizedKeyword));
  });
  const openEditor = (record: RoleRecord | "new") => {
    if (record !== "new" && record.builtIn) {
      message.info("超级管理员角色由系统内置，不能编辑");
      return;
    }
    setEditor(record);
    setEditingMembers(record === "new" ? [] : record.members);
    setRoleMemberKeyword("");
    setRoleMemberView("all");
    form.setFieldsValue(record === "new"
      ? { name: "", description: "", status: true, members: [] }
      : { ...record, status: record.status === "启用" });
  };
  const columns: TableProps<RoleRecord>["columns"] = [
    { title: "角色", dataIndex: "name", width: 220, fixed: "left", render: (value: string, record) => <div className="gov-primary-cell"><strong>{value}{record.builtIn ? <Tag color="gold" icon={<LockOutlined />}>系统内置</Tag> : null}</strong></div> },
    { title: "说明", dataIndex: "description", width: 300, ellipsis: true },
    { title: "页面权限", dataIndex: "pagePermissions", width: 105, render: (value: number) => <strong>{value}</strong> },
    { title: "动作权限", dataIndex: "actionPermissions", width: 105, render: (value: number) => <strong>{value}</strong> },
    { title: "用户数", dataIndex: "users", width: 110, render: (value: number, record) => record.builtIn ? <Tag bordered={false}>1 个内置账号</Tag> : <Button type="link" className="gov-count-link" onClick={() => { setMemberRole(record); setMemberKeyword(""); }}>{value} 人</Button> },
    { title: "状态", dataIndex: "status", width: 88, render: (status: EnableStatus) => <StatusTag status={status} /> },
    { title: "操作", fixed: "right", width: 146, align: "center", render: (_, record) => <Space size={4}><Tooltip title={record.builtIn ? "系统内置角色不可编辑" : "编辑角色"}><Button disabled={record.builtIn} type="text" aria-label="编辑角色" icon={<EditOutlined />} onClick={() => openEditor(record)} /></Tooltip><Tooltip title={record.builtIn ? "查看全部权限（只读）" : "配置权限"}><Button type="text" aria-label={record.builtIn ? "查看超级管理员权限" : "配置权限"} icon={record.builtIn ? <LockOutlined /> : <SafetyCertificateOutlined />} onClick={() => navigate(`/admin/permissions?roleId=${encodeURIComponent(record.id)}`)} /></Tooltip><Tooltip title={record.builtIn ? "系统内置角色不可停用" : record.status === "启用" ? "停用" : "启用"}><Button disabled={record.builtIn} type="text" aria-label={record.status === "启用" ? "停用角色" : "启用角色"} icon={record.status === "启用" ? <StopOutlined /> : <CheckCircleOutlined />} onClick={() => { setRoles((rows) => rows.map((item) => item.id === record.id ? { ...item, status: item.status === "启用" ? "停用" : "启用" } : item)); message.success(`角色已${record.status === "启用" ? "停用" : "启用"}`); }} /></Tooltip></Space> },
  ];
  return (
    <div className="page-stack gov-page">
      <Alert type="info" showIcon message="一个用户可以拥有多个角色" description="系统页面与动作权限取所有角色的并集。角色只决定系统功能权限，不等同于流程节点的办理资格。" />
      <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}>
        <div className="gov-toolbar"><Input allowClear prefix={<SearchOutlined />} placeholder="搜索角色名称或说明" value={keyword} onChange={(event) => setKeyword(event.target.value)} /><Space><Typography.Text type="secondary">共 {filtered.length} 个角色</Typography.Text><Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor("new")}>新增角色</Button></Space></div>
        <Table<RoleRecord> rowKey="id" columns={columns} dataSource={filtered} scroll={{ x: 940 }} pagination={{ pageSize: 10, showSizeChanger: false }} />
      </Card>
      <Drawer width={620} open={editor !== null} onClose={() => setEditor(null)} title={editor === "new" ? "新增角色" : "编辑角色"} extra={<Space><Button onClick={() => setEditor(null)}>取消</Button><Button type="primary" onClick={() => form.submit()}>保存</Button></Space>}>
        <Form form={form} layout="vertical" onFinish={(values) => {
          if (editor === "new") setRoles((rows) => {
            const identity = nextRoleIdentity(rows);
            return [...rows, { ...identity, name: values.name.trim(), description: values.description, status: values.status ? "启用" : "停用", members: editingMembers, users: editingMembers.length, pagePermissions: 0, actionPermissions: 0 }];
          });
          else if (editor) setRoles((rows) => rows.map((item) => item.id === editor.id ? { ...item, name: values.name.trim(), description: values.description, status: values.status ? "启用" : "停用", members: editingMembers, users: editingMembers.length } : item));
          message.success("角色已保存"); setEditor(null);
        }}>
          <Form.Item name="name" label="角色名称" rules={[
            { required: true, whitespace: true, message: "请输入角色名称" },
            {
              validator: (_, value) => {
                const name = String(value ?? "").trim();
                const currentId = editor !== "new" ? editor?.id : undefined;
                return roles.some((role) => role.id !== currentId && role.name.trim() === name)
                  ? Promise.reject(new Error("角色名称已存在"))
                  : Promise.resolve();
              },
            },
          ]}><Input maxLength={40} showCount /></Form.Item>
          <Form.Item name="description" label="角色说明"><Input.TextArea rows={3} /></Form.Item>
          <div className="gov-role-member-picker">
            <div className="gov-role-member-picker__head">
              <div><strong>角色成员</strong><Typography.Text type="secondary">用户可同时加入多个角色</Typography.Text></div>
              <Tag color="blue">已选择 {editingMembers.length} 人</Tag>
            </div>
            <div className="gov-role-member-picker__toolbar">
              <Input allowClear prefix={<SearchOutlined />} placeholder="搜索姓名、部门或职务" value={roleMemberKeyword} onChange={(event) => setRoleMemberKeyword(event.target.value)} />
              <Segmented
                value={roleMemberView}
                onChange={(value) => setRoleMemberView(value as "all" | "selected")}
                options={[
                  { label: `全部成员 ${roleMemberCandidates.length}`, value: "all" },
                  { label: `已选择 ${editingMembers.length}`, value: "selected" },
                ]}
              />
            </div>
            <div className="gov-role-member-picker__bulk">
              <Typography.Text type="secondary">当前显示 {visibleRoleMembers.length} 人</Typography.Text>
              <Space size={4}>
                <Button type="link" size="small" disabled={visibleRoleMembers.length === 0} onClick={() => setEditingMembers((current) => Array.from(new Set([...current, ...visibleRoleMembers.map((member) => member.name)])))}>选择当前结果</Button>
                <Button type="link" size="small" disabled={editingMembers.length === 0} onClick={() => setEditingMembers([])}>清空已选</Button>
              </Space>
            </div>
            <div className="gov-role-member-picker__list">
              {visibleRoleMembers.map((member) => (
                <label className={editingMembers.includes(member.name) ? "gov-role-member-option is-selected" : "gov-role-member-option"} key={member.name}>
                  <Checkbox
                    checked={editingMembers.includes(member.name)}
                    onChange={(event) => setEditingMembers((current) => event.target.checked ? [...new Set([...current, member.name])] : current.filter((name) => name !== member.name))}
                  />
                  <PersonChip name={member.name} detail={member.department} />
                  <Tag bordered={false}>{member.jobTitle}</Tag>
                </label>
              ))}
              {visibleRoleMembers.length === 0 && <div className="gov-role-member-picker__empty">没有符合条件的成员</div>}
            </div>
            <Typography.Text className="gov-role-member-picker__hint" type="secondary">正式版本使用服务端搜索与分页，已选择成员可单独查看，不再压缩成多选标签。</Typography.Text>
          </div>
          <Form.Item name="status" label="状态" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="停用" /></Form.Item>
        </Form>
      </Drawer>
      <Drawer width={480} open={Boolean(memberRole)} onClose={() => setMemberRole(null)} title={`${memberRole?.name ?? ""} · 成员预览`}>
        <Input allowClear prefix={<SearchOutlined />} placeholder="搜索成员" value={memberKeyword} onChange={(event) => setMemberKeyword(event.target.value)} />
        <div className="gov-member-list">{(memberRole?.members ?? []).filter((name) => name.includes(memberKeyword)).map((name, index) => <div className="gov-member-row" key={name}><PersonChip name={name} detail={departmentByIndex[index % departmentByIndex.length].path} /><Tag>{configuredRoleJobTitles[index % Math.max(configuredRoleJobTitles.length, 1)]?.name ?? "未设置"}</Tag></div>)}</div>
        <Typography.Text type="secondary">原型仅展示部分成员；正式列表采用服务端搜索与分页。</Typography.Text>
      </Drawer>
    </div>
  );
}

interface PermissionRow { key: string; module: string; page: string; description: string; actions: string[]; }
const permissionRows: PermissionRow[] = [
  { key: "work-launch", module: "员工工作区", page: "流程发起", description: "进入发起中心并提交流程权限组授权的流程", actions: ["查看", "发起"] },
  { key: "work-task", module: "员工工作区", page: "任务中心", description: "查看我的待办与可代办", actions: ["查看", "审核", "驳回"] },
  { key: "work-list", module: "员工工作区", page: "流程清单", description: "查看已获授权的流程实例", actions: ["查看", "复制新建", "打印"] },
  { key: "config-definition", module: "流程配置", page: "流程定义", description: "创建和维护流程版本", actions: ["查看", "编辑", "发布"] },
  { key: "config-form", module: "流程配置", page: "表单设计器", description: "配置初始表单与列表字段", actions: ["查看", "编辑", "预览"] },
  { key: "org-user", module: "用户与权限", page: "用户管理", description: "维护本地用户及多角色关系", actions: ["查看", "编辑", "重置密码"] },
  { key: "org-department", module: "用户与权限", page: "部门管理", description: "维护两级组织架构", actions: ["查看", "编辑"] },
  { key: "org-role", module: "用户与权限", page: "角色管理", description: "配置系统页面及动作权限", actions: ["查看", "编辑", "授权"] },
  { key: "org-group", module: "用户与权限", page: "流程权限组", description: "维护流程节点处理成员", actions: ["查看", "编辑"] },
  { key: "system-monitor", module: "系统运维", page: "流程实例监控", description: "只读查看全部流程实例", actions: ["查看", "导出"] },
  { key: "system-audit", module: "系统运维", page: "操作审计", description: "查看敏感操作记录", actions: ["查看", "导出"] },
];

type RolePermissionMap = Record<string, string[]>;

const workflowAdminGranted = ["work-task:查看", "work-task:审核", "work-task:驳回", "work-list:查看", "work-list:打印", "config-definition:查看", "config-definition:编辑", "config-definition:发布", "config-form:查看", "config-form:编辑"];
const reviewerGranted = ["work-task:查看", "work-task:审核", "work-task:驳回", "work-list:查看"];
const defaultRolePermissionMap: RolePermissionMap = {
  "ROLE-SUPER": permissionRows.flatMap((row) => row.actions.map((action) => `${row.key}:${action}`)),
  "ROLE-001": permissionRows.flatMap((row) => row.actions.map((action) => `${row.key}:${action}`)),
  "ROLE-002": workflowAdminGranted,
  "ROLE-003": ["work-launch:查看", "work-launch:发起", "work-task:查看", "work-list:查看", "work-list:复制新建", "work-list:打印"],
  "ROLE-004": reviewerGranted,
  "ROLE-005": reviewerGranted,
  "ROLE-006": reviewerGranted,
  "ROLE-007": ["work-list:查看"],
};

function readRolePermissionMap(): RolePermissionMap {
  try {
    const stored = JSON.parse(window.localStorage.getItem(ROLE_PERMISSION_STORAGE_KEY) ?? "{}") as RolePermissionMap;
    const saved = Object.fromEntries(
      Object.entries(stored).map(([roleId, permissions]) => [roleId, normalizeRolePermissionList(permissions)]),
    );
    if (JSON.stringify(stored) !== JSON.stringify(saved)) {
      window.localStorage.setItem(ROLE_PERMISSION_STORAGE_KEY, JSON.stringify(saved));
    }
    return {
      ...defaultRolePermissionMap,
      ...saved,
      "ROLE-SUPER": defaultRolePermissionMap["ROLE-SUPER"],
    };
  } catch {
    return { ...defaultRolePermissionMap };
  }
}

function writeRolePermissionMap(value: RolePermissionMap) {
  window.localStorage.setItem(ROLE_PERMISSION_STORAGE_KEY, JSON.stringify(value));
}

function readStoredRoles(): RoleRecord[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(ROLE_STORAGE_KEY) ?? "null") as RoleRecord[] | null;
    return Array.isArray(saved) && saved.length
      ? [superAdminRole, ...saved.filter((role) => role.id !== superAdminRole.id)]
      : initialRoles;
  } catch {
    return initialRoles;
  }
}

function summarizePermissions(grants: Iterable<string>) {
  const values = Array.from(grants);
  return {
    pagePermissions: new Set(values.map((value) => value.slice(0, value.lastIndexOf(":")))).size,
    actionPermissions: values.length,
  };
}

function applyRolePermissionStats(roles: RoleRecord[], permissionMap: RolePermissionMap) {
  return roles.map((role) => ({ ...role, ...summarizePermissions(permissionMap[role.id] ?? []) }));
}

function loadRolesWithPermissionStats() {
  return applyRolePermissionStats(readStoredRoles(), readRolePermissionMap());
}

function permissionSetsEqual(left: Iterable<string>, right: Iterable<string>) {
  const leftValues = new Set(left);
  const rightValues = new Set(right);
  return leftValues.size === rightValues.size && Array.from(leftValues).every((value) => rightValues.has(value));
}

export function PermissionManagementPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [availableRoles] = useState(loadRolesWithPermissionStats);
  const requestedRoleId = searchParams.get("roleId");
  const initialRoleId = availableRoles.some((role) => role.id === requestedRoleId) ? requestedRoleId! : "ROLE-002";
  const [roleId, setRoleId] = useState(initialRoleId);
  const [permissionsByRole, setPermissionsByRole] = useState(readRolePermissionMap);
  const [granted, setGranted] = useState(() => new Set(permissionsByRole[initialRoleId] ?? []));
  const [pendingRoleId, setPendingRoleId] = useState<string | null>(null);
  const currentRole = availableRoles.find((role) => role.id === roleId) ?? availableRoles[0];
  const isBuiltInRole = Boolean(currentRole.builtIn);
  const isDirty = !permissionSetsEqual(granted, permissionsByRole[roleId] ?? []);
  const permissionStats = summarizePermissions(granted);
  const blocker = useBlocker(useCallback(
    ({ currentLocation, nextLocation }) => isDirty && currentLocation.pathname !== nextLocation.pathname,
    [isDirty],
  ));
  useBeforeUnload(useCallback((event) => {
    if (!isDirty) return;
    event.preventDefault();
    event.returnValue = "";
  }, [isDirty]));
  const toggle = (key: string, checked: boolean) => setGranted((current) => {
    if (isBuiltInRole) return current;
    const next = new Set(current);
    const separatorIndex = key.lastIndexOf(":");
    const pageKey = key.slice(0, separatorIndex);
    const action = key.slice(separatorIndex + 1);
    if (checked) {
      next.add(key);
      if (action !== "查看") next.add(`${pageKey}:查看`);
    } else if (action === "查看") {
      Array.from(next).filter((value) => value.startsWith(`${pageKey}:`)).forEach((value) => next.delete(value));
    } else {
      next.delete(key);
    }
    return next;
  });
  const switchRole = (nextRoleId: string, permissionMap = permissionsByRole) => {
    setRoleId(nextRoleId);
    setGranted(new Set(permissionMap[nextRoleId] ?? []));
    setSearchParams({ roleId: nextRoleId }, { replace: true });
    message.info(`已切换到“${availableRoles.find((role) => role.id === nextRoleId)?.name ?? nextRoleId}”的权限配置`);
  };
  const selectRole = (nextRoleId: string) => {
    if (nextRoleId === roleId) return;
    if (isDirty) {
      setPendingRoleId(nextRoleId);
      return;
    }
    switchRole(nextRoleId);
  };
  const persistPermissions = () => {
    if (isBuiltInRole) return permissionsByRole;
    const nextPermissionMap = { ...permissionsByRole, [roleId]: Array.from(granted) };
    setPermissionsByRole(nextPermissionMap);
    writeRolePermissionMap(nextPermissionMap);
    window.localStorage.setItem(ROLE_STORAGE_KEY, JSON.stringify(applyRolePermissionStats(readStoredRoles(), nextPermissionMap)));
    notifyRolePermissionsChanged();
    return nextPermissionMap;
  };
  const savePermissions = () => {
    persistPermissions();
    message.success(`${currentRole.name} 的权限已保存`);
  };
  return (
    <div className="page-stack gov-page">
      <Alert
        type={isBuiltInRole ? "info" : "warning"}
        showIcon
        icon={isBuiltInRole ? <LockOutlined /> : undefined}
        message={isBuiltInRole ? "超级管理员权限为系统内置，只读展示" : "角色权限统一在本页配置"}
        description={isBuiltInRole ? "该角色始终拥有全部页面和动作权限，并可越过流程权限组执行所有流程的发起与审核；它不会出现在流程人员名单或候选人选择器中。" : "日常新增、修改和启用/停用统一由“编辑”权限控制；发布、授权、重置密码、导出等敏感动作仍单独授权。某个流程节点由谁处理，仍由“流程权限组”配置。"}
      />
      <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}>
        <div className="gov-permission-toolbar"><div><Select aria-label="选择要配置的角色" showSearch optionFilterProp="label" value={roleId} onChange={selectRole} options={availableRoles.map((role) => ({ value: role.id, label: `${role.name}${role.builtIn ? " · 系统内置" : role.status === "停用" ? " · 已停用" : ""}` }))} /></div><Space><Tag color={isBuiltInRole ? "gold" : isDirty ? "gold" : "green"}>{isBuiltInRole ? "全部权限 · 不可修改" : isDirty ? "有未保存修改" : "已保存"}</Tag><Button disabled={isBuiltInRole || !isDirty} onClick={() => { setGranted(new Set(permissionsByRole[roleId] ?? [])); message.info("已恢复当前角色上次保存的权限"); }}>恢复</Button><Button disabled={isBuiltInRole || !isDirty} type="primary" icon={isBuiltInRole ? <LockOutlined /> : <SafetyCertificateOutlined />} onClick={savePermissions}>保存权限</Button></Space></div>
        <div className="gov-permission-summary"><div><strong>{permissionStats.pagePermissions}</strong><span>已授权页面</span></div><Progress percent={Math.round(granted.size / permissionRows.reduce((sum, row) => sum + row.actions.length, 0) * 100)} showInfo={false} /><Typography.Text type="secondary">已选择 {permissionStats.actionPermissions} 个动作；保存后角色列表统计同步更新，不会改变流程待办。</Typography.Text></div>
        <div className="gov-permission-matrix">
          <div className="gov-permission-row gov-permission-head"><span>模块 / 页面</span><span>页面说明</span><span>动作权限</span></div>
          {permissionRows.map((row, index) => <div className="gov-permission-row" key={row.key}><div className="gov-permission-page">{index === 0 || permissionRows[index - 1]?.module !== row.module ? <small>{row.module}</small> : <small className="is-continuation">↳</small>}<strong>{row.page}</strong></div><Typography.Text type="secondary">{row.description}</Typography.Text><div className="gov-permission-actions">{row.actions.map((action) => <Checkbox disabled={isBuiltInRole} key={action} checked={granted.has(`${row.key}:${action}`)} onChange={(event) => toggle(`${row.key}:${action}`, event.target.checked)}>{action}</Checkbox>)}</div></div>)}
        </div>
      </Card>
      <Modal
        open={Boolean(pendingRoleId)}
        title="当前角色权限尚未保存"
        onCancel={() => setPendingRoleId(null)}
        closable={false}
        maskClosable={false}
        footer={[
          <Button key="cancel" onClick={() => setPendingRoleId(null)}>取消</Button>,
          <Button key="discard" danger onClick={() => { if (pendingRoleId) switchRole(pendingRoleId); setPendingRoleId(null); }}>放弃修改并切换</Button>,
          <Button key="save" type="primary" onClick={() => { const nextMap = persistPermissions(); if (pendingRoleId) switchRole(pendingRoleId, nextMap); setPendingRoleId(null); }}>保存并切换</Button>,
        ]}
      >
        <Typography.Paragraph>你修改了“{currentRole.name}”的权限。切换角色前请选择如何处理这些修改。</Typography.Paragraph>
      </Modal>
      <Modal
        open={blocker.state === "blocked"}
        title="离开前保存权限修改？"
        onCancel={() => blocker.state === "blocked" && blocker.reset()}
        closable={false}
        maskClosable={false}
        footer={[
          <Button key="stay" onClick={() => blocker.state === "blocked" && blocker.reset()}>留在当前页</Button>,
          <Button key="discard" danger onClick={() => blocker.state === "blocked" && blocker.proceed()}>放弃修改并离开</Button>,
          <Button key="save" type="primary" onClick={() => { persistPermissions(); if (blocker.state === "blocked") blocker.proceed(); }}>保存并离开</Button>,
        ]}
      >
        <Typography.Paragraph>“{currentRole.name}”存在未保存的权限修改。直接离开会丢失这些修改。</Typography.Paragraph>
      </Modal>
    </div>
  );
}

type GroupPurpose = "发起" | "审批" | "自由流程受理";
interface GroupRecord { id: string; name: string; processes: string[]; purposes: GroupPurpose[]; directMembers: string[]; linkedRoles: string[]; status: EnableStatus; referenced: boolean; openTasks: number; updatedAt: string; }
const groupRoleMembers: Record<string, string[]> = {
  "研发审核员": ["张伟", "林晓", "赵磊", "陈晨", "刘洋", "周宁"],
  "质量审核员": ["王敏", "孙悦", "吴昊", "徐洁", "杨帆"],
  "生产审核员": ["胡静", "高远", "许诺", "郑宇", "唐薇", "韩松"],
  "文控专员": ["王敏", "曹颖", "冯浩"],
};
const initialGroups: GroupRecord[] = [
  { id: "PG-0001", name: "PDF审核_发起权限组", processes: ["PDF审核"], purposes: ["发起"], directMembers: ["王敏", "曹颖"], linkedRoles: ["文控专员"], status: "启用", referenced: true, openTasks: 7, updatedAt: "2026-08-13 10:32" },
  { id: "PG-0002", name: "PDF审核_研发_审核组", processes: ["PDF审核", "测试报告审核"], purposes: ["审批"], directMembers: ["赵磊", "林晓"], linkedRoles: ["研发审核员"], status: "启用", referenced: true, openTasks: 12, updatedAt: "2026-08-13 09:18" },
  { id: "PG-0003", name: "PDF审核_质量_审核组", processes: ["PDF审核", "测试报告审核"], purposes: ["审批"], directMembers: ["王敏"], linkedRoles: ["质量审核员"], status: "启用", referenced: true, openTasks: 9, updatedAt: "2026-08-12 17:45" },
  { id: "PG-0004", name: "PDF审核_生产_审核组", processes: ["PDF审核"], purposes: ["审批"], directMembers: ["韩松"], linkedRoles: ["生产审核员"], status: "启用", referenced: true, openTasks: 9, updatedAt: "2026-08-12 16:21" },
  { id: "PG-0005", name: "测试报告_发起权限组", processes: ["测试报告审核"], purposes: ["发起"], directMembers: ["周宁", "许诺"], linkedRoles: [], status: "启用", referenced: true, openTasks: 3, updatedAt: "2026-08-11 14:05" },
  { id: "PG-0006", name: "测试报告_复核组", processes: [], purposes: ["审批", "自由流程受理"], directMembers: ["林晓", "孙悦"], linkedRoles: ["质量审核员"], status: "启用", referenced: false, openTasks: 0, updatedAt: "2026-08-10 11:28" },
];

function effectiveMembers(group: Pick<GroupRecord, "directMembers" | "linkedRoles">) {
  return Array.from(new Set([...group.directMembers, ...group.linkedRoles.flatMap((role) => groupRoleMembers[role] ?? [])]));
}

export function WorkflowPermissionGroupsPage() {
  const [groups, setGroups] = useState(initialGroups);
  const [keyword, setKeyword] = useState("");
  const [process, setProcess] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [editor, setEditor] = useState<GroupRecord | "new" | null>(null);
  const [preview, setPreview] = useState<GroupRecord | null>(null);
  const [directMembers, setDirectMembers] = useState<string[]>([]);
  const [linkedRoles, setLinkedRoles] = useState<string[]>([]);
  const [effectiveMemberKeyword, setEffectiveMemberKeyword] = useState("");
  const [form] = Form.useForm();
  const filtered = groups.filter((group) => `${group.name}${group.id}`.toLowerCase().includes(keyword.toLowerCase()) && (!process || group.processes.includes(process)) && (!status || group.status === status));
  const derived = effectiveMembers({ directMembers, linkedRoles });
  const visibleDerived = derived.filter((name) => name.toLowerCase().includes(effectiveMemberKeyword.trim().toLowerCase()));
  const openEditor = (record: GroupRecord | "new") => { setEditor(record); setEffectiveMemberKeyword(""); const values = record === "new" ? { name: "", purposes: ["审批"] as GroupPurpose[], status: true, directMembers: [], linkedRoles: [] } : { ...record, status: record.status === "启用" }; setDirectMembers(values.directMembers); setLinkedRoles(values.linkedRoles); form.setFieldsValue(values); };
  const columns: TableProps<GroupRecord>["columns"] = [
    { title: "流程权限组", dataIndex: "name", width: 260, fixed: "left", render: (value: string, record) => <div className="gov-primary-cell"><strong>{value}</strong><small>{record.id}</small></div> },
    { title: "已引用流程", dataIndex: "processes", width: 240, render: (values: string[]) => values.length ? <Space size={[4, 4]} wrap>{values.map((value) => <Tag key={value} bordered={false}>{value}</Tag>)}</Space> : <Typography.Text type="secondary">暂未关联流程</Typography.Text> },
    { title: "允许用途", dataIndex: "purposes", width: 220, render: (values: GroupPurpose[]) => <Space size={[4, 4]} wrap>{values.map((value) => <Tag key={value} color={value === "发起" ? "cyan" : value === "审批" ? "blue" : "purple"}>{value}</Tag>)}</Space> },
    { title: "成员构成", key: "composition", width: 220, render: (_, record) => <div className="gov-composition"><span><UserOutlined /> 直接 {record.directMembers.length}</span><span><TeamOutlined /> 角色 {record.linkedRoles.length}</span></div> },
    { title: "有效成员", key: "effective", width: 112, render: (_, record) => <Button className="gov-count-link" type="link" onClick={() => setPreview(record)}>{effectiveMembers(record).length} 人</Button> },
    { title: "运行待办", dataIndex: "openTasks", width: 100, render: (value: number) => value ? <Tag color="processing">{value} 项</Tag> : <Tag>无</Tag> },
    { title: "状态", dataIndex: "status", width: 84, render: (value: EnableStatus) => <StatusTag status={value} /> },
    { title: "更新时间", dataIndex: "updatedAt", width: 150 },
    { title: "操作", fixed: "right", width: 142, align: "center", render: (_, record) => <Space size={4}><Tooltip title="编辑"><Button type="text" aria-label={`编辑权限组：${record.name}`} icon={<EditOutlined />} onClick={() => openEditor(record)} /></Tooltip><Tooltip title="有效成员预览"><Button type="text" aria-label={`预览有效成员：${record.name}`} icon={<EyeOutlined />} onClick={() => setPreview(record)} /></Tooltip><Tooltip title={record.status === "启用" ? "停用" : "启用"}><Popconfirm title={record.status === "启用" && record.openTasks ? `停用不影响已有 ${record.openTasks} 项待办，确认继续？` : "确认修改状态？"} onConfirm={() => { setGroups((rows) => rows.map((item) => item.id === record.id ? { ...item, status: item.status === "启用" ? "停用" : "启用" } : item)); message.success(`权限组已${record.status === "启用" ? "停用" : "启用"}`); }}><Button type="text" aria-label={`${record.status === "启用" ? "停用" : "启用"}权限组：${record.name}`} icon={record.status === "启用" ? <StopOutlined /> : <CheckCircleOutlined />} /></Popconfirm></Tooltip></Space> },
  ];
  return (
    <div className="page-stack gov-page">
      <Alert type="info" showIcon message="成员变化立即影响运行中的待办" description="直接成员和关联角色成员合并去重后形成有效成员。允许用途决定权限组可出现的设计位置，已引用流程由系统自动统计；停用权限组不影响已运行流程，引用后不可删除。" />
      <Card className="query-card gov-query-card"><div className="gov-filter-grid gov-filter-grid--groups"><label><span>关键词</span><Input allowClear prefix={<SearchOutlined />} placeholder="权限组名称或编号" value={keyword} onChange={(event) => setKeyword(event.target.value)} /></label><label><span>已引用流程</span><Select allowClear placeholder="全部流程" value={process} onChange={setProcess} options={["PDF审核", "测试报告审核", "自由协作"].map((value) => ({ value }))} /></label><label><span>状态</span><Select allowClear placeholder="全部状态" value={status} onChange={setStatus} options={["启用", "停用"].map((value) => ({ value }))} /></label><div className="gov-filter-actions"><Button icon={<ReloadOutlined />} onClick={() => { setKeyword(""); setProcess(undefined); setStatus(undefined); }}>重置</Button></div></div></Card>
      <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}><ResultHeader title="流程权限组" count={filtered.length} extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor("new")}>新增权限组</Button>} /><Table<GroupRecord> rowKey="id" columns={columns} dataSource={filtered} scroll={{ x: 1400 }} pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 个权限组` }} /></Card>
      <Drawer width={720} open={editor !== null} onClose={() => setEditor(null)} title={editor === "new" ? "新增流程权限组" : "编辑流程权限组"} extra={<Space><Button onClick={() => setEditor(null)}>取消</Button><Button type="primary" onClick={() => form.submit()}>保存并立即生效</Button></Space>}>
        {editor !== "new" && editor?.openTasks ? <Alert className="gov-drawer-alert" type="warning" showIcon message={`当前有 ${editor.openTasks} 项运行待办`} description="保存后，新增成员立即获得处理资格；被移除成员将立即失去尚未处理的待办资格。" /> : null}
        <Form form={form} layout="vertical" onFinish={(values) => { const processes = editor === "new" ? [] : editor!.processes; const record: GroupRecord = { id: editor === "new" ? `PG-${String(groups.length + 1).padStart(4, "0")}` : editor!.id, name: values.name, processes, purposes: values.purposes, directMembers, linkedRoles, status: values.status ? "启用" : "停用", referenced: processes.length > 0, openTasks: editor === "new" ? 0 : editor!.openTasks, updatedAt: "2026-08-13 14:20" }; setGroups((rows) => editor === "new" ? [...rows, record] : rows.map((item) => item.id === record.id ? record : item)); message.success("流程权限组已保存，成员资格已立即更新"); setEditor(null); }}>
          <div className="gov-form-grid"><Form.Item name="name" label="权限组名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="status" label="状态" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="停用" /></Form.Item></div>
          <div className="gov-group-editor-section gov-group-reference-section">
            <div className="gov-section-title"><span><ApartmentOutlined />已引用流程</span><Tag>{editor !== "new" && editor ? editor.processes.length : 0} 个</Tag></div>
            <Typography.Paragraph type="secondary">由流程基本信息和节点设计中的实际引用自动统计，不在权限组中重复维护。</Typography.Paragraph>
            <Space size={[6, 6]} wrap>{editor !== "new" && editor?.processes.length ? editor.processes.map((value) => <Tag key={value} color="geekblue">{value}</Tag>) : <Typography.Text type="secondary">暂未关联流程，保存后可在流程设计中引用。</Typography.Text>}</Space>
          </div>
          <div className="gov-group-editor-section">
            <div className="gov-section-title"><span><SafetyCertificateOutlined />允许用途</span></div>
            <Typography.Paragraph type="secondary">可同时选择多个用途；流程设计器会根据当前位置筛选符合用途的权限组。</Typography.Paragraph>
            <Form.Item name="purposes" rules={[{ required: true, message: "请至少选择一种用途" }]}>
              <Checkbox.Group className="gov-purpose-checkboxes" options={["发起", "审批", "自由流程受理"].map((value) => ({ label: value, value }))} />
            </Form.Item>
          </div>
          <div className="gov-group-editor-section"><div className="gov-section-title"><span><UserOutlined />直接成员</span><Tag>{directMembers.length} 人</Tag></div><Typography.Paragraph type="secondary">逐个加入的固定人员，不依赖其系统角色。</Typography.Paragraph><Form.Item name="directMembers"><Select mode="multiple" showSearch optionFilterProp="label" maxTagCount="responsive" options={peopleNames.map((value) => ({ value, label: value }))} onChange={setDirectMembers} /></Form.Item></div>
          <div className="gov-group-editor-section"><div className="gov-section-title"><span><TeamOutlined />关联角色</span><Tag>{linkedRoles.length} 个</Tag></div><Typography.Paragraph type="secondary">角色下的全部用户动态加入；角色成员变化会立即同步到本权限组。</Typography.Paragraph><Form.Item name="linkedRoles"><Select mode="multiple" showSearch optionFilterProp="label" options={Object.keys(groupRoleMembers).map((value) => ({ value, label: value }))} onChange={setLinkedRoles} /></Form.Item></div>
          <div className="gov-effective-preview">
            <div className="gov-effective-preview__head"><strong>有效成员预览</strong><Tag color="blue">去重后 {derived.length} 人</Tag></div>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索有效成员全名"
              value={effectiveMemberKeyword}
              onChange={(event) => setEffectiveMemberKeyword(event.target.value)}
            />
            <div className="gov-effective-member-grid">
              {visibleDerived.map((name) => {
                const direct = directMembers.includes(name);
                const roles = linkedRoles.filter((role) => (groupRoleMembers[role] ?? []).includes(name));
                return (
                  <div className="gov-effective-member" key={name}>
                    <div><strong>{name}</strong><Tag color="success" bordered={false}>有效</Tag></div>
                    <small>{[direct ? "直接加入" : "", roles.length ? `角色带入：${roles.join("、")}` : ""].filter(Boolean).join(" · ")}</small>
                  </div>
                );
              })}
              {visibleDerived.length === 0 && <div className="gov-effective-member-empty">没有符合条件的有效成员</div>}
            </div>
            <Typography.Text type="secondary">完整姓名与成员来源直接显示；成员较多时可搜索并在列表内滚动查看。</Typography.Text>
          </div>
        </Form>
      </Drawer>
      <Drawer width={560} open={Boolean(preview)} onClose={() => setPreview(null)} title={`${preview?.name ?? ""} · 有效成员`}>
        <Alert className="gov-drawer-alert" type="info" showIcon message="相同人员仅计一次" description="来源标签用于说明人员是被直接添加、通过角色加入，或同时来自两种方式。" />
        <div className="gov-member-list">{preview ? effectiveMembers(preview).map((name, index) => { const direct = preview.directMembers.includes(name); const roles = preview.linkedRoles.filter((role) => (groupRoleMembers[role] ?? []).includes(name)); return <div className="gov-member-row" key={name}><PersonChip name={name} detail={departmentByIndex[index % departmentByIndex.length].path} /><Space size={[4, 4]} wrap>{direct ? <Tag color="cyan">直接加入</Tag> : null}{roles.map((role) => <Tag color="purple" key={role}>角色带入：{role}</Tag>)}</Space></div>; }) : null}</div>
      </Drawer>
    </div>
  );
}

type InstanceMonitorStatus = "审核中" | "驳回待处理" | "已完成" | "已关闭" | "进行中";
interface MonitorRecord { id: string; code: string; title: string; process: string; version: string; status: InstanceMonitorStatus; node: string; initiator: string; department: string; createdAt: string; updatedAt: string; }
const monitorRows: MonitorRecord[] = [
  { id: "MON-1", code: "PDF-202608-0042", title: "MTR-320 步进电机装配作业指导书", process: "PDF审核", version: "V2", status: "审核中", node: "研发、质量、生产审核", initiator: "王敏", department: "文控", createdAt: "2026-08-13 09:10", updatedAt: "2026-08-13 11:26" },
  { id: "MON-2", code: "PDF-202608-0041", title: "驱动器来料检验规范", process: "PDF审核", version: "V2", status: "驳回待处理", node: "发布方重新处理", initiator: "曹颖", department: "文控", createdAt: "2026-08-12 16:35", updatedAt: "2026-08-13 10:02" },
  { id: "MON-3", code: "TR-202608-0019", title: "高低温循环测试报告", process: "测试报告审核", version: "V1", status: "审核中", node: "质量复核", initiator: "周宁", department: "研发 / 测试", createdAt: "2026-08-12 14:20", updatedAt: "2026-08-13 09:46" },
  { id: "MON-4", code: "PDF-202608-0038", title: "包装工位作业指导书", process: "PDF审核", version: "V1", status: "已完成", node: "", initiator: "王敏", department: "文控", createdAt: "2026-08-10 08:42", updatedAt: "2026-08-11 16:18" },
  { id: "MON-5", code: "FC-202608-0015", title: "产线扫码异常排查", process: "自由协作", version: "V1", status: "进行中", node: "张伟", initiator: "韩松", department: "生产 / 一车间", createdAt: "2026-08-11 10:06", updatedAt: "2026-08-13 12:40" },
  { id: "MON-6", code: "FC-202608-0011", title: "供应商标签信息确认", process: "自由协作", version: "V1", status: "已关闭", node: "", initiator: "徐洁", department: "质量 / 来料检验", createdAt: "2026-08-08 13:34", updatedAt: "2026-08-12 15:10" },
  { id: "MON-7", code: "PDF-202608-0035", title: "MTR-180 最终检验规范", process: "PDF审核", version: "V1", status: "已关闭", node: "", initiator: "冯浩", department: "文控", createdAt: "2026-08-07 09:12", updatedAt: "2026-08-09 17:22" },
];
const monitorStatuses: InstanceMonitorStatus[] = ["审核中", "驳回待处理", "已完成", "已关闭", "进行中"];

export function InstanceMonitorPage() {
  const [keyword, setKeyword] = useState("");
  const [process, setProcess] = useState<string>();
  const [status, setStatus] = useState<InstanceMonitorStatus>();
  const [detail, setDetail] = useState<MonitorRecord | null>(null);
  const filtered = monitorRows.filter((row) => `${row.code}${row.title}${row.initiator}`.toLowerCase().includes(keyword.toLowerCase()) && (!process || row.process === process) && (!status || row.status === status));
  const columns: TableProps<MonitorRecord>["columns"] = [
    { title: "实例编号", dataIndex: "code", width: 170, fixed: "left", render: (value: string, record) => <Button className="gov-table-link" type="link" onClick={() => setDetail(record)}>{value}</Button> },
    { title: "标题", dataIndex: "title", width: 280, ellipsis: true },
    { title: "流程 / 版本", dataIndex: "process", width: 155, render: (value: string, record) => <div className="gov-primary-cell"><strong>{value}</strong><small>{record.version}</small></div> },
    { title: "状态", dataIndex: "status", width: 118, render: (value: InstanceMonitorStatus) => <StatusPill status={value} /> },
    { title: "当前节点", dataIndex: "node", width: 210, ellipsis: true, render: (value: string) => value || "—" },
    { title: "发起人", dataIndex: "initiator", width: 125, render: (value: string, record) => <div className="gov-primary-cell"><strong>{value}</strong><small>{record.department}</small></div> },
    { title: "发起时间", dataIndex: "createdAt", width: 155 },
    { title: "更新时间", dataIndex: "updatedAt", width: 155 },
    { title: "操作", fixed: "right", width: 80, align: "center", render: (_, record) => <Tooltip title="查看详情"><Button type="text" aria-label={`查看流程实例：${record.title}`} icon={<EyeOutlined />} onClick={() => setDetail(record)} /></Tooltip> },
  ];
  return (
    <div className="page-stack gov-page">
      <Alert type="info" showIcon message="实例监控为只读页面" description="运维人员可以查询和查看流程、表单及流转信息，但不能强制关闭、改派、跳过节点或修改业务数据。" />
      <Card className="query-card gov-query-card"><div className="gov-filter-grid gov-filter-grid--monitor"><label><span>关键词</span><Input allowClear prefix={<SearchOutlined />} placeholder="实例编号、标题或发起人" value={keyword} onChange={(event) => setKeyword(event.target.value)} /></label><label><span>流程</span><Select allowClear placeholder="全部流程" value={process} onChange={setProcess} options={["PDF审核", "测试报告审核", "自由协作"].map((value) => ({ value }))} /></label><label><span>状态</span><Select allowClear placeholder="全部状态" value={status} onChange={setStatus} options={monitorStatuses.map((value) => ({ value }))} /></label><label><span>发起时间</span><DatePicker.RangePicker /></label><div className="gov-filter-actions"><Button type="primary" icon={<SearchOutlined />} onClick={() => message.success(`已查询到 ${filtered.length} 条实例`)}>查询</Button><Button icon={<ReloadOutlined />} onClick={() => { setKeyword(""); setProcess(undefined); setStatus(undefined); }}>重置</Button></div></div></Card>
      <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}><ResultHeader title="流程实例" count={filtered.length} extra={<Typography.Text type="secondary"><LockOutlined /> 全部操作只读</Typography.Text>} /><Table<MonitorRecord> rowKey="id" columns={columns} dataSource={filtered} scroll={{ x: 1510 }} pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 条实例` }} /></Card>
      <Drawer width={660} open={Boolean(detail)} onClose={() => setDetail(null)} title="流程实例详情（只读）">
        {detail ? <><div className="gov-detail-hero-row"><span className="gov-detail-icon"><FileSearchOutlined /></span><div><Typography.Title level={4}>{detail.title}</Typography.Title><Typography.Text type="secondary">{detail.code} · {detail.process} {detail.version}</Typography.Text></div><StatusPill status={detail.status} /></div><Descriptions bordered column={2} size="small" items={[{ key: "initiator", label: "发起人", children: `${detail.initiator}（${detail.department}）` }, { key: "created", label: "发起时间", children: detail.createdAt }, { key: "node", label: "当前节点", children: detail.node || "—" }, { key: "updated", label: "更新时间", children: detail.updatedAt }]} /><div className="gov-detail-section"><div className="gov-section-title">流转概览</div><Timeline items={[{ color: "green", children: <><strong>{detail.initiator} 发起流程</strong><small>{detail.createdAt}</small></> }, { color: "blue", children: <><strong>进入 {detail.node || "结束"}</strong><small>{detail.updatedAt}</small></> }, { color: "gray", children: <Typography.Text type="secondary">后续流转记录将在这里按时间显示</Typography.Text> }]} /></div><Alert type="warning" showIcon message="只读限制" description="本页没有强制关闭、异常改派、跳过节点或修改表单的入口。" /></> : null}
      </Drawer>
    </div>
  );
}

type AuditResult = "成功" | "失败";
interface AuditRecord { id: string; operator: string; department: string; module: string; object: string; objectId: string; action: string; result: AuditResult; ip: string; time: string; before: string; after: string; detail: string; }
const auditRows: AuditRecord[] = [
  { id: "LOG-20260813-0088", operator: "王敏", department: "文控", module: "流程实例", object: "MTR-320 步进电机装配作业指导书", objectId: "PDF-202608-0042", action: "重新发布", result: "成功", ip: "10.20.3.46", time: "2026-08-13 11:26:08", before: "状态：驳回待处理\n轮次：1", after: "状态：审核中\n轮次：2", detail: "保留原实例编号，全部并行审批分支重新开始。" },
  { id: "LOG-20260813-0087", operator: "林晓", department: "研发 / 软件", module: "审批任务", object: "研发审核", objectId: "TASK-00981", action: "提交审核", result: "成功", ip: "10.20.12.31", time: "2026-08-13 11:21:42", before: "审核状态：待审核", after: "审核状态：通过", detail: "以流程权限组成员身份完成审批。" },
  { id: "LOG-20260813-0086", operator: "赵磊", department: "研发", module: "用户管理", object: "用户 user083", objectId: "USR-0083", action: "重置密码", result: "成功", ip: "10.20.1.18", time: "2026-08-13 11:09:17", before: "密码：******", after: "密码：******", detail: "管理员手动重置本地账号密码。" },
  { id: "LOG-20260813-0085", operator: "陈晨", department: "研发 / 硬件", module: "登录认证", object: "本地账号登录", objectId: "user146", action: "登录", result: "失败", ip: "10.20.16.72", time: "2026-08-13 10:58:03", before: "—", after: "认证失败", detail: "账号或密码错误；首版不触发连续失败锁定。" },
  { id: "LOG-20260813-0084", operator: "王敏", department: "文控", module: "流程权限组", object: "PDF审核_质量_审核组", objectId: "PG-0003", action: "修改成员", result: "成功", ip: "10.20.3.46", time: "2026-08-13 10:42:55", before: "直接成员：王敏、孙悦", after: "直接成员：王敏\n关联角色：质量审核员", detail: "变更已立即影响运行中待办的有效成员范围。" },
  { id: "LOG-20260813-0083", operator: "周宁", department: "研发 / 测试", module: "自由协作", object: "产线扫码异常排查", objectId: "FC-202608-0015", action: "改派受理人", result: "成功", ip: "10.20.12.44", time: "2026-08-13 10:31:20", before: "当前受理人：周宁", after: "当前受理人：张伟", detail: "异常改派操作，时间线已记录。" },
  { id: "LOG-20260813-0082", operator: "系统管理员", department: "系统", module: "角色权限", object: "流程管理员", objectId: "ROLE-002", action: "保存权限", result: "成功", ip: "10.20.1.10", time: "2026-08-13 10:15:06", before: "页面权限：7\n动作权限：19", after: "页面权限：8\n动作权限：21", detail: "新增流程版本停用权限。" },
];

export function AuditLogPage() {
  const [keyword, setKeyword] = useState("");
  const [module, setModule] = useState<string>();
  const [result, setResult] = useState<AuditResult>();
  const [detail, setDetail] = useState<AuditRecord | null>(null);
  const filtered = auditRows.filter((row) => `${row.operator}${row.object}${row.objectId}${row.ip}`.toLowerCase().includes(keyword.toLowerCase()) && (!module || row.module === module) && (!result || row.result === result));
  const columns: TableProps<AuditRecord>["columns"] = [
    { title: "时间", dataIndex: "time", width: 170, fixed: "left" },
    { title: "操作人", dataIndex: "operator", width: 145, render: (value: string, record) => <div className="gov-primary-cell"><strong>{value}</strong><small>{record.department}</small></div> },
    { title: "模块", dataIndex: "module", width: 120, render: (value: string) => <Tag>{value}</Tag> },
    { title: "操作对象", dataIndex: "object", width: 285, ellipsis: true, render: (value: string, record) => <div className="gov-primary-cell"><strong>{value}</strong><small>{record.objectId}</small></div> },
    { title: "动作", dataIndex: "action", width: 120 },
    { title: "结果", dataIndex: "result", width: 88, render: (value: AuditResult) => <StatusPill status={value} /> },
    { title: "IP 地址", dataIndex: "ip", width: 130 },
    { title: "操作", fixed: "right", width: 78, align: "center", render: (_, record) => <Tooltip title="查看详情"><Button type="text" aria-label={`查看审计日志：${record.id}`} icon={<EyeOutlined />} onClick={() => setDetail(record)} /></Tooltip> },
  ];
  return (
    <div className="page-stack gov-page">
      <SummaryStrip items={[{ label: "今日操作", value: 126, note: "成功 124 次" }, { label: "失败操作", value: 2, note: "均为登录失败", tone: "red" }, { label: "敏感变更", value: 9, note: "权限与成员调整", tone: "blue" }, { label: "日志保留", value: "长期", note: "不可编辑或删除" }]} />
      <Card className="query-card gov-query-card"><div className="gov-filter-grid gov-filter-grid--audit"><label><span>关键词</span><Input allowClear prefix={<SearchOutlined />} placeholder="操作人、对象、编号或 IP" value={keyword} onChange={(event) => setKeyword(event.target.value)} /></label><label><span>模块</span><Select allowClear placeholder="全部模块" value={module} onChange={setModule} options={Array.from(new Set(auditRows.map((row) => row.module))).map((value) => ({ value }))} /></label><label><span>结果</span><Select allowClear placeholder="全部结果" value={result} onChange={setResult} options={["成功", "失败"].map((value) => ({ value }))} /></label><label><span>操作时间</span><DatePicker.RangePicker showTime /></label><div className="gov-filter-actions"><Button type="primary" icon={<SearchOutlined />} onClick={() => message.success(`已查询到 ${filtered.length} 条日志`)}>查询</Button><Button icon={<ReloadOutlined />} onClick={() => { setKeyword(""); setModule(undefined); setResult(undefined); }}>重置</Button></div></div></Card>
      <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}><ResultHeader title="操作审计" count={filtered.length} extra={<Typography.Text type="secondary"><AuditOutlined /> 审计记录只读且不可删除</Typography.Text>} /><Table<AuditRecord> rowKey="id" columns={columns} dataSource={filtered} scroll={{ x: 1240 }} pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 条日志` }} /></Card>
      <Drawer width={680} open={Boolean(detail)} onClose={() => setDetail(null)} title="审计详情">
        {detail ? <><div className="gov-audit-detail-head"><span className={`gov-audit-result is-${detail.result === "成功" ? "success" : "error"}`}>{detail.result === "成功" ? <CheckCircleOutlined /> : <StopOutlined />}</span><div><Typography.Title level={4}>{detail.action}</Typography.Title><Typography.Text type="secondary">{detail.id} · {detail.time}</Typography.Text></div><StatusPill status={detail.result} /></div><Descriptions bordered column={2} size="small" items={[{ key: "operator", label: "操作人", children: `${detail.operator}（${detail.department}）` }, { key: "ip", label: "IP 地址", children: detail.ip }, { key: "module", label: "模块", children: detail.module }, { key: "objectId", label: "对象编号", children: detail.objectId }, { key: "object", label: "操作对象", span: 2, children: detail.object }]} /><div className="gov-audit-values"><div><span>变更前</span><pre>{detail.before}</pre></div><div><span>变更后</span><pre>{detail.after}</pre></div></div><Alert type="info" showIcon message="操作说明" description={detail.detail} /></> : null}
      </Drawer>
    </div>
  );
}
