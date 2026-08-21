import {
  ApartmentOutlined,
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
  App,
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
import { useUnsavedChangesGuard } from "../components/UnsavedChangesGuard";
import {
  ROLE_PERMISSION_STORAGE_KEY,
  normalizeRolePermissionList,
  notifyRolePermissionsChanged,
} from "../state/rolePermissions";
import {
  findIdentityUser,
  useIdentityStore,
  type DomainRole,
  type DomainUser,
  type AuthenticationMode,
  type WorkflowGroupPurpose,
  type WorkflowPermissionGroup,
} from "../state/useIdentityStore";
import {
  departmentCascaderOptions,
  useOrganizationStore,
  type DepartmentRecord,
  type JobTitleRecord,
} from "../state/useOrganizationStore";
import { usePrototypeStore } from "../state/usePrototypeStore";
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { readLocalAuditEvents } from "../utils/localAuditRepository";
import { createDefaultDateRange, isDateTimeInRange, normalizeDayRange } from "../utils/dateRange";
import { collectRuntimeAuditEvents } from "../utils/runtimeAudit";
import { isBrowserMockMode } from "../utils/runtimeMode";
import { deriveAllWorkflowGroupStatistics } from "../state/workflowGroupStatistics";
import { flowPilotApi } from "../api/flowPilotApi";
import type { AuditEvent } from "../api/contracts";
import "./governance-pages.css";

type EnableStatus = "启用" | "停用";
type JobTitle = string;

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

type UserRecord = DomainUser;

const authenticationModeLabel: Record<AuthenticationMode, string> = {
  domain: "域登录",
  password: "密码登录",
};

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

function useCloseEditorConfirmation() {
  const { modal } = App.useApp();
  return useCallback((dirty: boolean, subject: string, onClose: () => void) => {
    if (!dirty) {
      onClose();
      return;
    }
    modal.confirm({
      title: `${subject}尚未保存`,
      content: "关闭编辑器后，当前修改将丢失。",
      okText: "放弃修改",
      okButtonProps: { danger: true },
      cancelText: "继续编辑",
      onOk: onClose,
    });
  }, [modal]);
}

export function UserManagementPage() {
  const confirmEditorClose = useCloseEditorConfirmation();
  const users = useIdentityStore((state) => state.users);
  const setUsers = useIdentityStore((state) => state.setUsers);
  const roles = useIdentityStore((state) => state.roles);
  const jobTitles = useOrganizationStore((state) => state.jobTitles);
  const departments = useOrganizationStore((state) => state.departments);
  const departmentOptions = useMemo(() => departmentCascaderOptions(departments), [departments]);
  const [draftFilters, setDraftFilters] = useState({ keyword: "", department: [] as string[], jobTitle: "", role: "", status: "" });
  const [filters, setFilters] = useState(draftFilters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [drawerUser, setDrawerUser] = useState<UserRecord | "new" | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [form] = Form.useForm();
  const selectedAuthenticationMode = Form.useWatch("authenticationMode", form) as AuthenticationMode | undefined;
  const { guard: userEditorGuard } = useUnsavedChangesGuard({
    dirty: editorDirty,
    title: "用户信息尚未保存",
    description: "离开后，当前用户编辑内容将丢失。",
  });

  const cacheUser = (user: Omit<UserRecord, "password">) => setUsers((rows) => {
    const current = rows.find((item) => item.id === user.id);
    const next = { ...current, ...user, password: current?.password ?? "" } as UserRecord;
    return current ? rows.map((item) => item.id === user.id ? next : item) : [next, ...rows];
  });
  const changeUserStatus = async (record: UserRecord) => {
    try {
      const resource = await flowPilotApi.directory.userResource(record.id);
      const updated = await flowPilotApi.directory.updateUserStatus(
        record.id,
        record.status === "启用" ? "停用" : "启用",
        resource.etag ?? "*",
      );
      cacheUser(updated);
      message.success(`账号已${updated.status}`);
    } catch {
      message.error("账号状态更新失败，请刷新后重试");
    }
  };
  const resetUserPassword = async (record: UserRecord) => {
    try {
      const result = await flowPilotApi.directory.resetPassword(record.id);
      message.success(`已为 ${record.name} 生成临时密码：${result.temporaryPassword}`);
    } catch {
      message.error("密码重置失败，请稍后重试");
    }
  };

  const activeJobTitles = jobTitles.filter((item) => item.status === "启用").sort((a, b) => a.sort - b.sort);
  const roleOptions = roles.map((role) => role.name);
  const assignableRoleOptions = roles.filter((role) => !role.builtIn && role.status === "启用").map((role) => role.name);
  const managerTitleName = jobTitles.find((item) => item.id === "JOB-001")?.name;
  const drawerJobTitle = drawerUser !== "new" ? drawerUser?.jobTitle : undefined;
  const selectableJobTitles = jobTitles
    .filter((item) => item.status === "启用" || item.name === drawerJobTitle)
    .sort((a, b) => a.sort - b.sort);

  const filtered = useMemo(() => users.filter((user) => {
    const keyword = filters.keyword.trim().toLowerCase();
    const matchesKeyword = !keyword || `${user.account}${user.name}${user.email}`.toLowerCase().includes(keyword);
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
    setEditorDirty(false);
    form.resetFields();
    form.setFieldsValue(user === "new" ? {
      account: "", email: "", name: "", authenticationMode: "domain", password: "", newPassword: "", department: [], jobTitle: activeJobTitles.find((item) => item.id === "JOB-002")?.name ?? activeJobTitles[0]?.name, roles: [], status: true,
    } : { ...user, newPassword: "" });
  };

  const columns: TableProps<UserRecord>["columns"] = [
    { title: "用户", dataIndex: "name", width: 190, fixed: "left", render: (_, record) => <Space size={6}><PersonChip name={record.name} detail={record.account} />{record.builtIn ? <Tag color="gold" icon={<LockOutlined />}>内置</Tag> : null}</Space> },
    { title: "邮箱", dataIndex: "email", width: 220, ellipsis: true },
    { title: "登录方式", dataIndex: "authenticationMode", width: 106, render: (mode: AuthenticationMode) => <Tag color={mode === "domain" ? "blue" : "default"}>{authenticationModeLabel[mode]}</Tag> },
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
            <Popconfirm disabled={record.builtIn} title={`确认${record.status === "启用" ? "停用" : "启用"} ${record.name}？`} onConfirm={() => void changeUserStatus(record)}><Button disabled={record.builtIn} type="text" aria-label={`${record.status === "启用" ? "停用" : "启用"}用户：${record.name}`} icon={record.status === "启用" ? <StopOutlined /> : <CheckCircleOutlined />} /></Popconfirm>
          </Tooltip>
          <Tooltip title={record.builtIn ? "系统内置账号密码不可在此重置" : record.authenticationMode === "domain" ? "域登录密码由域系统维护" : "重置密码"}><Popconfirm disabled={record.builtIn || record.authenticationMode === "domain"} title="生成临时密码并立即生效？" onConfirm={() => void resetUserPassword(record)}><Button disabled={record.builtIn || record.authenticationMode === "domain"} type="text" aria-label={`重置密码：${record.name}`} icon={<KeyOutlined />} /></Popconfirm></Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div className="page-stack gov-page">
      {userEditorGuard}
      <SummaryStrip items={[
        { label: "用户总数", value: users.length, note: "按服务端分页加载" },
        { label: "启用账号", value: users.filter((item) => item.status === "启用").length, note: "可正常登录", tone: "green" },
        { label: "多角色用户", value: users.filter((item) => item.roles.length > 1).length, note: "权限取角色并集", tone: "blue" },
        { label: "域登录账号", value: users.filter((item) => item.authenticationMode === "domain").length, note: "普通用户默认方式" },
      ]} />
      <Card className="query-card gov-query-card">
        <div className="gov-filter-grid gov-filter-grid--users">
          <label><span>关键词</span><Input allowClear prefix={<SearchOutlined />} placeholder="登录账号、员工姓名或邮箱" value={draftFilters.keyword} onChange={(event) => setDraftFilters({ ...draftFilters, keyword: event.target.value })} /></label>
          <label><span>部门</span><Cascader changeOnSelect allowClear options={departmentOptions} placeholder="一级或二级部门" value={draftFilters.department} onChange={(value) => setDraftFilters({ ...draftFilters, department: value.map(String) })} /></label>
          <label><span>职务</span><Select allowClear placeholder="全部职务" value={draftFilters.jobTitle || undefined} options={[...jobTitles].sort((a, b) => a.sort - b.sort).map((item) => ({ value: item.name, label: item.status === "停用" ? `${item.name}（已停用）` : item.name }))} onChange={(value) => setDraftFilters({ ...draftFilters, jobTitle: value ?? "" })} /></label>
          <label><span>角色</span><Select showSearch allowClear placeholder="全部角色" value={draftFilters.role || undefined} options={roleOptions.map((value) => ({ value }))} onChange={(value) => setDraftFilters({ ...draftFilters, role: value ?? "" })} /></label>
          <label><span>状态</span><Select allowClear placeholder="全部状态" value={draftFilters.status || undefined} options={["启用", "停用"].map((value) => ({ value }))} onChange={(value) => setDraftFilters({ ...draftFilters, status: value ?? "" })} /></label>
          <div className="gov-filter-actions"><Button type="primary" icon={<SearchOutlined />} onClick={() => { setFilters(draftFilters); setPage(1); }}>查询</Button><Button icon={<ReloadOutlined />} onClick={() => { const empty = { keyword: "", department: [], jobTitle: "", role: "", status: "" }; setDraftFilters(empty); setFilters(empty); setPage(1); }}>重置</Button></div>
        </div>
      </Card>
      <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}>
        <ResultHeader title="用户列表" count={filtered.length} extra={<><Typography.Text type="secondary">仅加载当前页数据</Typography.Text><Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor("new")}>新增用户</Button></>} />
        <Table<UserRecord> rowKey="id" columns={columns} dataSource={pageRows} scroll={{ x: 1420 }} pagination={{ current: page, pageSize, total: filtered.length, showSizeChanger: true, pageSizeOptions: [10, 20, 50], showTotal: (total) => `共 ${total} 名用户`, onChange: (nextPage, nextPageSize) => { setPage(nextPageSize === pageSize ? nextPage : 1); setPageSize(nextPageSize); } }} />
      </Card>
      <Drawer width={600} open={drawerUser !== null} onClose={() => confirmEditorClose(editorDirty, "用户信息", () => { setEditorDirty(false); setDrawerUser(null); })} title={drawerUser === "new" ? "新增用户" : "编辑用户"} extra={<Space><Button onClick={() => confirmEditorClose(editorDirty, "用户信息", () => { setEditorDirty(false); setDrawerUser(null); })}>取消</Button><Button type="primary" onClick={() => form.submit()}>保存</Button></Space>}>
        <Alert
          className="gov-drawer-alert"
          type="info"
          showIcon
          message={drawerUser === "new" ? "普通用户默认使用域登录" : "可调整普通用户的登录方式"}
          description={drawerUser === "new" ? "域登录不设置本地密码；密码登录必须填写初始密码。部门、职务与角色仍相互独立。" : "切换为密码登录时需要设置新密码；切换为域登录后，密码由域系统维护。账号状态仍通过列表操作处理。"}
        />
        <Form form={form} layout="vertical" requiredMark="optional" onValuesChange={() => setEditorDirty(true)} onFinish={async (values) => {
          const path = values.department.length === 1 ? departmentOptions.find((item) => item.value === values.department[0])?.label : `${departmentOptions.find((item) => item.value === values.department[0])?.label} / ${departmentOptions.find((item) => item.value === values.department[0])?.children?.find((item) => item.value === values.department[1])?.label}`;
          try {
            if (drawerUser === "new") {
              const created = await flowPilotApi.directory.createUser({ account: values.account, email: String(values.email).trim(), authenticationMode: values.authenticationMode, password: values.authenticationMode === "password" ? values.password : undefined, name: values.name, department: values.department, departmentPath: String(path), jobTitle: values.jobTitle, roles: values.roles, status: values.status ? "启用" : "停用" });
              cacheUser(created);
              message.success("用户已创建");
            } else if (drawerUser) {
              const resource = await flowPilotApi.directory.userResource(drawerUser.id);
              const updated = await flowPilotApi.directory.updateUser(drawerUser.id, { account: values.account, email: String(values.email).trim(), authenticationMode: values.authenticationMode, newPassword: drawerUser.authenticationMode === "domain" && values.authenticationMode === "password" ? values.newPassword : undefined, name: values.name, department: values.department, departmentPath: String(path), jobTitle: values.jobTitle, roles: values.roles }, resource.etag);
              cacheUser(updated);
              message.success("用户信息已保存");
            }
          } catch {
            message.error("用户保存失败，请检查输入或刷新后重试");
            return;
          }
          setEditorDirty(false);
          setDrawerUser(null);
        }}>
          <div className="gov-form-grid">
            <Form.Item name="account" label="登录账号" rules={[{ required: true, message: "请输入登录账号" }, { validator: (_, value) => String(value ?? "").trim().toLowerCase() === "superadmin" ? Promise.reject(new Error("该账号由系统内置，不能创建或修改")) : Promise.resolve() }]}><Input maxLength={40} /></Form.Item>
            <Form.Item name="name" label="员工姓名" rules={[{ required: true, message: "请输入员工姓名" }]}><Input maxLength={40} /></Form.Item>
          </div>
          <Form.Item
            name="email"
            label="邮箱"
            rules={[
              { required: true, message: "请输入邮箱" },
              { type: "email", message: "请输入有效邮箱地址" },
            ]}
            extra="流程进入审核节点或结束时，将按此邮箱发送已配置的通知。"
          >
            <Input maxLength={120} placeholder="name@company.com" />
          </Form.Item>
          <Form.Item name="authenticationMode" label="登录方式" rules={[{ required: true, message: "请选择登录方式" }]} extra="域登录由正式后端连接公司域服务校验；浏览器 Mock 仍使用统一演示密码。"><Select options={[{ value: "domain", label: "域登录（默认）" }, { value: "password", label: "密码登录" }]} /></Form.Item>
          {drawerUser === "new" && selectedAuthenticationMode === "password" && <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 1, message: "密码至少 1 个字符" }]} extra="仅密码登录用户需要设置；正式后端使用 Argon2id 保存散列。"><Input.Password maxLength={64} /></Form.Item>}
          {drawerUser !== "new" && drawerUser?.authenticationMode === "domain" && selectedAuthenticationMode === "password" && <Form.Item name="newPassword" label="新密码" rules={[{ required: true, min: 1, message: "切换为密码登录时必须设置新密码" }]}><Input.Password maxLength={64} /></Form.Item>}
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

export function DepartmentManagementPage() {
  const confirmEditorClose = useCloseEditorConfirmation();
  const [section, setSection] = useState<"departments" | "jobTitles">("departments");
  const storedDepartments = useOrganizationStore((state) => state.departments);
  const setDepartments = useOrganizationStore((state) => state.setDepartments);
  const storedJobTitles = useOrganizationStore((state) => state.jobTitles);
  const setJobTitles = useOrganizationStore((state) => state.setJobTitles);
  const identityUsers = useIdentityStore((state) => state.users);
  const departments = useMemo(() => storedDepartments.map((department) => {
    const users = identityUsers.filter((user) => user.department.includes(department.key)).length;
    return { ...department, users, referenced: users > 0 };
  }), [identityUsers, storedDepartments]);
  const jobTitles = useMemo(() => storedJobTitles.map((jobTitle) => ({
    ...jobTitle,
    users: identityUsers.filter((user) => user.jobTitle === jobTitle.name).length,
  })), [identityUsers, storedJobTitles]);
  const [selectedKey, setSelectedKey] = useState("rd");
  const [editor, setEditor] = useState<{ mode: "new-root" | "new-child" | "edit"; record?: DepartmentRecord } | null>(null);
  const [jobTitleEditor, setJobTitleEditor] = useState<JobTitleRecord | "new" | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [form] = Form.useForm();
  const [jobTitleForm] = Form.useForm();
  const { guard: organizationEditorGuard } = useUnsavedChangesGuard({
    dirty: editorDirty,
    title: "组织信息尚未保存",
    description: "离开后，当前部门或职务的编辑内容将丢失。",
  });

  const cacheDepartment = (record: import("../api/contracts").DepartmentRecord) => setDepartments((rows) => {
    const current = rows.find((item) => item.key === record.id);
    const next: DepartmentRecord = {
      key: record.id,
      name: record.name,
      path: record.path,
      level: record.parentId ? 2 : 1,
      parentKey: record.parentId,
      sort: record.sortOrder,
      status: record.status,
      users: record.memberCount,
      referenced: record.memberCount > 0,
      description: record.description ?? current?.description ?? "",
    };
    return current ? rows.map((item) => item.key === record.id ? next : item) : [...rows, next];
  });
  const cachePosition = (record: import("../api/contracts").PositionRecord) => setJobTitles((rows) => {
    const current = rows.find((item) => item.id === record.id);
    const next: JobTitleRecord = {
      id: record.id,
      name: record.name,
      description: record.description,
      status: record.status,
      users: record.memberCount,
      sort: record.sortOrder ?? current?.sort ?? (rows.length + 1) * 10,
    };
    return current ? rows.map((item) => item.id === record.id ? next : item) : [...rows, next];
  });
  const changeDepartmentStatus = async (record: DepartmentRecord) => {
    try {
      const resource = await flowPilotApi.organization.department(record.key);
      cacheDepartment(await flowPilotApi.organization.updateDepartment(
        record.key,
        { status: record.status === "启用" ? "停用" : "启用" },
        resource.etag ?? "*",
      ));
      message.success(`部门已${record.status === "启用" ? "停用" : "启用"}`);
    } catch {
      message.error("部门状态更新失败，请刷新后重试");
    }
  };
  const deleteDepartment = async (record: DepartmentRecord) => {
    try {
      const resource = await flowPilotApi.organization.department(record.key);
      await flowPilotApi.organization.removeDepartment(record.key, resource.etag ?? "*");
      setDepartments((rows) => rows.filter((item) => item.key !== record.key));
      setSelectedKey("rd");
      message.success("未引用部门已删除");
    } catch {
      message.error("部门删除失败，请确认没有用户或下级部门引用");
    }
  };
  const changePositionStatus = async (record: JobTitleRecord) => {
    try {
      const resource = await flowPilotApi.organization.position(record.id);
      cachePosition(await flowPilotApi.organization.updatePosition(
        record.id,
        { status: record.status === "启用" ? "停用" : "启用" },
        resource.etag ?? "*",
      ));
      message.success(`职务已${record.status === "启用" ? "停用" : "启用"}`);
    } catch {
      message.error("职务状态更新失败，请刷新后重试");
    }
  };
  const deletePosition = async (record: JobTitleRecord) => {
    try {
      const resource = await flowPilotApi.organization.position(record.id);
      await flowPilotApi.organization.removePosition(record.id, resource.etag ?? "*");
      setJobTitles((rows) => rows.filter((item) => item.id !== record.id));
      message.success("职务已删除");
    } catch {
      message.error("职务删除失败，请确认没有用户引用");
    }
  };

  const selected = departments.find((item) => item.key === selectedKey) ?? departments[0];
  const treeData = departments.filter((item) => item.level === 1).sort((a, b) => a.sort - b.sort).map((root) => ({
    key: root.key,
    title: <span className="gov-tree-title"><span>{root.name}</span><Tag bordered={false}>{root.users} 人</Tag>{root.status === "停用" ? <StatusPill status="停用" compact /> : null}</span>,
    children: departments.filter((item) => item.parentKey === root.key).sort((a, b) => a.sort - b.sort).map((child) => ({ key: child.key, title: <span className="gov-tree-title"><span>{child.name}</span><Tag bordered={false}>{child.users} 人</Tag>{child.status === "停用" ? <StatusPill status="停用" compact /> : null}</span> })),
  }));
  const openDepartmentEditor = (mode: "new-root" | "new-child" | "edit") => {
    const record = mode === "edit" ? selected : undefined;
    setEditor({ mode, record });
    setEditorDirty(false);
    form.setFieldsValue(record ? { ...record, status: record.status === "启用" } : { name: "", sort: 10, status: true, description: "" });
  };
  const openJobTitleEditor = (record: JobTitleRecord | "new") => {
    setJobTitleEditor(record);
    setEditorDirty(false);
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
        <Tooltip title={record.status === "启用" ? "停用职务" : "启用职务"}><Button type="text" aria-label={`${record.status === "启用" ? "停用" : "启用"}职务：${record.name}`} icon={record.status === "启用" ? <StopOutlined /> : <CheckCircleOutlined />} onClick={() => void changePositionStatus(record)} /></Tooltip>
        <Tooltip title={record.users ? "已有用户使用，不能删除" : "删除职务"}><Popconfirm disabled={record.users > 0} title="确认删除这个职务？" onConfirm={() => void deletePosition(record)}><Button type="text" danger disabled={record.users > 0} icon={<DeleteOutlined />} /></Popconfirm></Tooltip>
      </Space>,
    },
  ];

  return (
    <div className="page-stack gov-page">
      {organizationEditorGuard}
      <Card className="gov-org-section-switch" bordered={false}>
        <Segmented
          className="app-mode-segmented gov-org-tabs"
          block
          value={section}
          onChange={(value) => { setEditorDirty(false); setSection(value as "departments" | "jobTitles"); setEditor(null); setJobTitleEditor(null); }}
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
              <Popconfirm title={`确认${selected.status === "启用" ? "停用" : "启用"}此部门？`} onConfirm={() => void changeDepartmentStatus(selected)}><Button icon={selected.status === "启用" ? <StopOutlined /> : <CheckCircleOutlined />}>{selected.status === "启用" ? "停用部门" : "启用部门"}</Button></Popconfirm>
              <Popconfirm disabled={selected.referenced} title="确认删除此部门？" onConfirm={() => void deleteDepartment(selected)}><Button danger disabled={selected.referenced} icon={<DeleteOutlined />}>删除部门</Button></Popconfirm>
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
      <Drawer width={520} open={section === "departments" && editor !== null} onClose={() => confirmEditorClose(editorDirty, "部门信息", () => { setEditorDirty(false); setEditor(null); })} title={editor?.mode === "edit" ? "编辑部门" : editor?.mode === "new-child" ? `在“${selected.name}”下新增二级部门` : "新增一级部门"} extra={<Space><Button onClick={() => confirmEditorClose(editorDirty, "部门信息", () => { setEditorDirty(false); setEditor(null); })}>取消</Button><Button type="primary" onClick={() => form.submit()}>保存</Button></Space>}>
        {editor?.mode === "new-child" && selected.level === 2 ? <Alert type="error" showIcon message="二级部门不能继续添加下级" /> : null}
        <Form form={form} layout="vertical" onValuesChange={() => setEditorDirty(true)} onFinish={async (values) => {
          try {
            if (editor?.mode === "edit") {
              const resource = await flowPilotApi.organization.department(selected.key);
              const saved = await flowPilotApi.organization.updateDepartment(selected.key, { name: values.name, sortOrder: values.sort, status: values.status ? "启用" : "停用", description: values.description }, resource.etag ?? "*");
              cacheDepartment(saved);
              message.success("部门信息已保存");
            } else {
              const isChild = editor?.mode === "new-child";
              const saved = await flowPilotApi.organization.createDepartment({ name: values.name, parentId: isChild ? selected.key : undefined, sortOrder: values.sort, description: values.description });
              cacheDepartment(saved);
              setSelectedKey(saved.id);
              message.success("部门已创建");
            }
          } catch {
            message.error("部门保存失败，请检查名称或刷新后重试");
            return;
          }
          setEditorDirty(false);
          setEditor(null);
        }}>
          <Form.Item name="name" label="部门名称" rules={[{ required: true, message: "请输入部门名称" }]}><Input maxLength={40} /></Form.Item>
          <Form.Item name="sort" label="显示排序" rules={[{ required: true }]}><InputNumber min={0} max={9999} style={{ width: "100%" }} /></Form.Item>
          <Form.Item name="status" label="状态" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="停用" /></Form.Item>
          <Form.Item name="description" label="部门说明"><Input.TextArea rows={4} maxLength={200} showCount /></Form.Item>
        </Form>
      </Drawer>
      <Drawer width={520} open={section === "jobTitles" && jobTitleEditor !== null} onClose={() => confirmEditorClose(editorDirty, "职务信息", () => { setEditorDirty(false); setJobTitleEditor(null); })} title={jobTitleEditor === "new" ? "新增职务" : "编辑职务"} extra={<Space><Button onClick={() => confirmEditorClose(editorDirty, "职务信息", () => { setEditorDirty(false); setJobTitleEditor(null); })}>取消</Button><Button type="primary" onClick={() => jobTitleForm.submit()}>保存</Button></Space>}>
        {jobTitleEditor !== "new" && jobTitleEditor?.users ? <Alert className="gov-drawer-alert" type="info" showIcon message={`当前有 ${jobTitleEditor.users} 名用户使用该职务`} description="可以修改名称、排序、状态和说明；名称修改后所有关联用户同步显示新名称，但该职务不能直接删除。" /> : null}
        <Form form={jobTitleForm} layout="vertical" onValuesChange={() => setEditorDirty(true)} onFinish={async (values) => {
          try {
            if (jobTitleEditor === "new") {
              cachePosition(await flowPilotApi.organization.createPosition({ name: values.name.trim(), description: values.description, sortOrder: values.sort }));
              message.success("职务已新增");
            } else if (jobTitleEditor) {
              const resource = await flowPilotApi.organization.position(jobTitleEditor.id);
              cachePosition(await flowPilotApi.organization.updatePosition(jobTitleEditor.id, { name: values.name.trim(), description: values.description, status: values.status ? "启用" : "停用", sortOrder: values.sort }, resource.etag ?? "*"));
              message.success("职务信息已保存");
            }
          } catch {
            message.error("职务保存失败，请检查名称或刷新后重试");
            return;
          }
          setEditorDirty(false);
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

type RoleRecord = DomainRole;

export function RoleManagementPage() {
  const confirmEditorClose = useCloseEditorConfirmation();
  const navigate = useNavigate();
  const roles = useIdentityStore((state) => state.roles);
  const setRoles = useIdentityStore((state) => state.setRoles);
  const identityUsers = useIdentityStore((state) => state.users);
  const organizationJobTitles = useOrganizationStore((state) => state.jobTitles);
  const [keyword, setKeyword] = useState("");
  const [editor, setEditor] = useState<RoleRecord | "new" | null>(null);
  const [memberRole, setMemberRole] = useState<RoleRecord | null>(null);
  const [memberKeyword, setMemberKeyword] = useState("");
  const [editingMembers, setEditingMembers] = useState<string[]>([]);
  const [roleMemberKeyword, setRoleMemberKeyword] = useState("");
  const [roleMemberView, setRoleMemberView] = useState<"all" | "selected">("all");
  const [editorDirty, setEditorDirty] = useState(false);
  const [form] = Form.useForm();
  const { guard: roleEditorGuard } = useUnsavedChangesGuard({
    dirty: editorDirty,
    title: "角色信息尚未保存",
    description: "离开后，角色资料和成员选择的修改将丢失。",
  });
  const cacheRole = (record: RoleRecord) => setRoles((rows) =>
    rows.some((item) => item.id === record.id)
      ? rows.map((item) => item.id === record.id ? record : item)
      : [...rows, record]);
  const changeRoleStatus = async (record: RoleRecord) => {
    try {
      const resource = await flowPilotApi.directory.roleResource(record.id);
      cacheRole(await flowPilotApi.directory.updateRole(
        record.id,
        { status: record.status === "启用" ? "停用" : "启用" },
        resource.etag,
      ));
      message.success(`角色已${record.status === "启用" ? "停用" : "启用"}`);
    } catch {
      message.error("角色状态更新失败，请刷新后重试");
    }
  };
  const filtered = roles.filter((role) => `${role.name}${role.description}`.toLowerCase().includes(keyword.toLowerCase()));
  const configuredRoleJobTitles = organizationJobTitles.filter((item) => item.status === "启用").sort((a, b) => a.sort - b.sort);
  const roleMemberCandidates = identityUsers.filter((user) => !user.builtIn).map((user) => ({
    name: user.name,
    department: user.departmentPath,
    jobTitle: user.jobTitle,
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
    setEditorDirty(false);
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
    { title: "操作", fixed: "right", width: 146, align: "center", render: (_, record) => <Space size={4}><Tooltip title={record.builtIn ? "系统内置角色不可编辑" : "编辑角色"}><Button disabled={record.builtIn} type="text" aria-label="编辑角色" icon={<EditOutlined />} onClick={() => openEditor(record)} /></Tooltip><Tooltip title={record.builtIn ? "查看全部权限（只读）" : "配置权限"}><Button type="text" aria-label={record.builtIn ? "查看超级管理员权限" : "配置权限"} icon={record.builtIn ? <LockOutlined /> : <SafetyCertificateOutlined />} onClick={() => navigate(`/admin/permissions?roleId=${encodeURIComponent(record.id)}`)} /></Tooltip><Tooltip title={record.builtIn ? "系统内置角色不可停用" : record.status === "启用" ? "停用" : "启用"}><Button disabled={record.builtIn} type="text" aria-label={record.status === "启用" ? "停用角色" : "启用角色"} icon={record.status === "启用" ? <StopOutlined /> : <CheckCircleOutlined />} onClick={() => void changeRoleStatus(record)} /></Tooltip></Space> },
  ];
  return (
    <div className="page-stack gov-page">
      {roleEditorGuard}
      <Alert type="info" showIcon message="一个用户可以拥有多个角色" description="系统页面与动作权限取所有角色的并集。角色只决定系统功能权限，不等同于流程节点的办理资格。" />
      <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}>
        <div className="gov-toolbar"><Input allowClear prefix={<SearchOutlined />} placeholder="搜索角色名称或说明" value={keyword} onChange={(event) => setKeyword(event.target.value)} /><Space><Typography.Text type="secondary">共 {filtered.length} 个角色</Typography.Text><Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor("new")}>新增角色</Button></Space></div>
        <Table<RoleRecord> rowKey="id" columns={columns} dataSource={filtered} scroll={{ x: 940 }} pagination={{ pageSize: 10, showSizeChanger: false }} />
      </Card>
      <Drawer width={620} open={editor !== null} onClose={() => confirmEditorClose(editorDirty, "角色信息", () => { setEditorDirty(false); setEditor(null); })} title={editor === "new" ? "新增角色" : "编辑角色"} extra={<Space><Button onClick={() => confirmEditorClose(editorDirty, "角色信息", () => { setEditorDirty(false); setEditor(null); })}>取消</Button><Button type="primary" onClick={() => form.submit()}>保存</Button></Space>}>
        <Form form={form} layout="vertical" onValuesChange={() => setEditorDirty(true)} onFinish={async (values) => {
          const patch = { name: values.name.trim(), description: values.description, status: values.status ? "启用" as const : "停用" as const, members: editingMembers };
          try {
            if (editor === "new") cacheRole(await flowPilotApi.directory.createRole(patch));
            else if (editor) {
              const resource = await flowPilotApi.directory.roleResource(editor.id);
              cacheRole(await flowPilotApi.directory.updateRole(editor.id, patch, resource.etag));
            }
            message.success("角色已保存");
          } catch {
            message.error("角色保存失败，请检查名称或刷新后重试");
            return;
          }
          setEditorDirty(false); setEditor(null);
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
                <Button type="link" size="small" disabled={visibleRoleMembers.length === 0} onClick={() => { setEditorDirty(true); setEditingMembers((current) => Array.from(new Set([...current, ...visibleRoleMembers.map((member) => member.name)]))); }}>选择当前结果</Button>
                <Button type="link" size="small" disabled={editingMembers.length === 0} onClick={() => { setEditorDirty(true); setEditingMembers([]); }}>清空已选</Button>
              </Space>
            </div>
            <div className="gov-role-member-picker__list">
              {visibleRoleMembers.map((member) => (
                <label className={editingMembers.includes(member.name) ? "gov-role-member-option is-selected" : "gov-role-member-option"} key={member.name}>
                  <Checkbox
                    checked={editingMembers.includes(member.name)}
                    onChange={(event) => { setEditorDirty(true); setEditingMembers((current) => event.target.checked ? [...new Set([...current, member.name])] : current.filter((name) => name !== member.name)); }}
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

function readStoredRoles(): RoleRecord[] {
  return useIdentityStore.getState().roles;
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

function permissionSetsEqual(left: Iterable<string>, right: Iterable<string>) {
  const leftValues = new Set(left);
  const rightValues = new Set(right);
  return leftValues.size === rightValues.size && Array.from(leftValues).every((value) => rightValues.has(value));
}

export function PermissionManagementPage() {
  const setIdentityRoles = useIdentityStore((state) => state.setRoles);
  const identityRoles = useIdentityStore((state) => state.roles);
  const [searchParams, setSearchParams] = useSearchParams();
  const [permissionsByRole, setPermissionsByRole] = useState(readRolePermissionMap);
  const availableRoles = useMemo(
    () => applyRolePermissionStats(identityRoles, permissionsByRole),
    [identityRoles, permissionsByRole],
  );
  const requestedRoleId = searchParams.get("roleId");
  const initialRoleId = availableRoles.some((role) => role.id === requestedRoleId) ? requestedRoleId! : "ROLE-002";
  const [roleId, setRoleId] = useState(initialRoleId);
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
  useEffect(() => {
    let cancelled = false;
    void flowPilotApi.organization.rolePermissions(roleId).then((resource) => {
      if (cancelled) return;
      const normalized = normalizeRolePermissionList(resource.data);
      setPermissionsByRole((current) => ({ ...current, [roleId]: normalized }));
      setGranted(new Set(normalized));
    }).catch(() => {
      if (!cancelled) message.error("角色权限加载失败，请刷新后重试");
    });
    return () => { cancelled = true; };
  }, [roleId]);
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
  const persistPermissions = async () => {
    if (isBuiltInRole) return permissionsByRole;
    const resource = await flowPilotApi.organization.rolePermissions(roleId);
    const saved = await flowPilotApi.organization.updateRolePermissions(roleId, Array.from(granted), resource.etag ?? "*");
    const nextPermissionMap = { ...permissionsByRole, [roleId]: saved };
    setPermissionsByRole(nextPermissionMap);
    const rolesWithStats = applyRolePermissionStats(readStoredRoles(), nextPermissionMap);
    setIdentityRoles(rolesWithStats);
    notifyRolePermissionsChanged();
    return nextPermissionMap;
  };
  const savePermissions = async () => {
    try {
      await persistPermissions();
      message.success(`${currentRole.name} 的权限已保存`);
    } catch {
      message.error("权限保存失败，请刷新后重试");
    }
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
          <Button key="save" type="primary" onClick={() => { void persistPermissions().then((nextMap) => { if (pendingRoleId) switchRole(pendingRoleId, nextMap); setPendingRoleId(null); }).catch(() => message.error("权限保存失败，请刷新后重试")); }}>保存并切换</Button>,
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
          <Button key="save" type="primary" onClick={() => { void persistPermissions().then(() => { if (blocker.state === "blocked") blocker.proceed(); }).catch(() => message.error("权限保存失败，请刷新后重试")); }}>保存并离开</Button>,
        ]}
      >
        <Typography.Paragraph>“{currentRole.name}”存在未保存的权限修改。直接离开会丢失这些修改。</Typography.Paragraph>
      </Modal>
    </div>
  );
}

type GroupPurpose = WorkflowGroupPurpose;
type GroupRecord = WorkflowPermissionGroup;
function effectiveMembers(group: Pick<GroupRecord, "directMembers" | "linkedRoles" | "directMemberUserIds" | "linkedRoleIds">) {
  const users = useIdentityStore.getState().users;
  return users
    .filter((user) => !user.builtIn && user.status === "启用")
    .filter((user) => group.directMemberUserIds?.includes(user.id)
      || user.roleIds?.some((roleId) => group.linkedRoleIds?.includes(roleId)))
    .map((user) => user.name);
}

export function WorkflowPermissionGroupsPage() {
  const confirmEditorClose = useCloseEditorConfirmation();
  const storedGroups = useIdentityStore((state) => state.workflowGroups);
  const setGroups = useIdentityStore((state) => state.setWorkflowGroups);
  const definitions = useProcessDefinitionStore((state) => state.definitions);
  const tasks = usePrototypeStore((state) => state.tasks);
  const groups = useMemo(
    () => deriveAllWorkflowGroupStatistics(storedGroups, definitions, tasks),
    [definitions, storedGroups, tasks],
  );
  const identityUsers = useIdentityStore((state) => state.users);
  const identityRoles = useIdentityStore((state) => state.roles);
  const [keyword, setKeyword] = useState("");
  const [process, setProcess] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [editor, setEditor] = useState<GroupRecord | "new" | null>(null);
  const [preview, setPreview] = useState<GroupRecord | null>(null);
  const [directMemberUserIds, setDirectMemberUserIds] = useState<string[]>([]);
  const [linkedRoleIds, setLinkedRoleIds] = useState<string[]>([]);
  const [effectiveMemberKeyword, setEffectiveMemberKeyword] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);
  const [form] = Form.useForm();
  const { guard: workflowGroupEditorGuard } = useUnsavedChangesGuard({
    dirty: editorDirty,
    title: "流程权限组尚未保存",
    description: "离开后，权限组用途、直接成员和关联角色的修改将丢失。",
  });
  const cacheGroup = (record: GroupRecord) => setGroups((rows) =>
    rows.some((item) => item.id === record.id)
      ? rows.map((item) => item.id === record.id ? record : item)
      : [...rows, record]);
  const changeGroupStatus = async (record: GroupRecord) => {
    try {
      const resource = await flowPilotApi.directory.groupResource(record.id);
      cacheGroup(await flowPilotApi.directory.updateGroup(
        record.id,
        { status: record.status === "启用" ? "停用" : "启用" },
        resource.etag,
      ));
      message.success(`权限组已${record.status === "启用" ? "停用" : "启用"}`);
    } catch {
      message.error("权限组状态更新失败，请刷新后重试");
    }
  };
  const filtered = groups.filter((group) => `${group.name}${group.id}`.toLowerCase().includes(keyword.toLowerCase()) && (!process || group.processes.includes(process)) && (!status || group.status === status));
  const directMembers = identityUsers.filter((user) => directMemberUserIds.includes(user.id)).map((user) => user.name);
  const linkedRoles = identityRoles.filter((role) => linkedRoleIds.includes(role.id)).map((role) => role.name);
  const derived = effectiveMembers({ directMembers, linkedRoles, directMemberUserIds, linkedRoleIds });
  const visibleDerived = derived.filter((name) => name.toLowerCase().includes(effectiveMemberKeyword.trim().toLowerCase()));
  const openEditor = (record: GroupRecord | "new") => {
    setEditor(record);
    setEditorDirty(false);
    setEffectiveMemberKeyword("");
    const memberIds = record === "new" ? [] : record.directMemberUserIds ?? identityUsers.filter((user) => record.directMembers.includes(user.name)).map((user) => user.id);
    const roleIds = record === "new" ? [] : record.linkedRoleIds ?? identityRoles.filter((role) => record.linkedRoles.includes(role.name)).map((role) => role.id);
    const values = record === "new"
      ? { name: "", purposes: ["审批/受理"] as GroupPurpose[], status: true, directMemberUserIds: [], linkedRoleIds: [] }
      : { ...record, directMemberUserIds: memberIds, linkedRoleIds: roleIds, status: record.status === "启用" };
    setDirectMemberUserIds(memberIds);
    setLinkedRoleIds(roleIds);
    form.setFieldsValue(values);
  };
  const columns: TableProps<GroupRecord>["columns"] = [
    { title: "流程权限组", dataIndex: "name", width: 260, fixed: "left", render: (value: string, record) => <div className="gov-primary-cell"><strong>{value}</strong><small>{record.code}</small></div> },
    { title: "已引用流程", dataIndex: "processes", width: 240, render: (values: string[]) => values.length ? <Space size={[4, 4]} wrap>{values.map((value) => <Tag key={value} bordered={false}>{value}</Tag>)}</Space> : <Typography.Text type="secondary">暂未关联流程</Typography.Text> },
    { title: "允许用途", dataIndex: "purposes", width: 220, render: (values: GroupPurpose[]) => <Space size={[4, 4]} wrap>{values.map((value) => <Tag key={value} color={value === "发起" ? "cyan" : value === "审批/受理" ? "blue" : "volcano"}>{value}</Tag>)}</Space> },
    { title: "成员构成", key: "composition", width: 220, render: (_, record) => <div className="gov-composition"><span><UserOutlined /> 直接 {record.directMemberUserIds?.length ?? record.directMembers.length}</span><span><TeamOutlined /> 角色 {record.linkedRoleIds?.length ?? record.linkedRoles.length}</span></div> },
    { title: "有效成员", key: "effective", width: 112, render: (_, record) => <Button className="gov-count-link" type="link" onClick={() => setPreview(record)}>{effectiveMembers(record).length} 人</Button> },
    { title: "状态", dataIndex: "status", width: 118, align: "center", render: (value: EnableStatus) => <StatusTag status={value} /> },
    { title: "更新时间", dataIndex: "updatedAt", width: 150 },
    { title: "操作", fixed: "right", width: 142, align: "center", render: (_, record) => <Space size={4}><Tooltip title="编辑"><Button type="text" aria-label={`编辑权限组：${record.name}`} icon={<EditOutlined />} onClick={() => openEditor(record)} /></Tooltip><Tooltip title="有效成员预览"><Button type="text" aria-label={`预览有效成员：${record.name}`} icon={<EyeOutlined />} onClick={() => setPreview(record)} /></Tooltip><Tooltip title={record.status === "启用" ? "停用" : "启用"}><Popconfirm title={record.status === "启用" && record.openTasks ? `停用不影响已有 ${record.openTasks} 项待办，确认继续？` : "确认修改状态？"} onConfirm={() => void changeGroupStatus(record)}><Button type="text" aria-label={`${record.status === "启用" ? "停用" : "启用"}权限组：${record.name}`} icon={record.status === "启用" ? <StopOutlined /> : <CheckCircleOutlined />} /></Popconfirm></Tooltip></Space> },
  ];
  return (
    <div className="page-stack gov-page">
      {workflowGroupEditorGuard}
      <Alert type="info" showIcon message="成员变化立即影响运行中的待办" description="直接成员和关联角色成员合并去重后形成有效成员。允许用途决定权限组可出现的设计位置，已引用流程由系统自动统计；停用权限组不影响已运行流程，引用后不可删除。" />
      <Card className="query-card gov-query-card"><div className="gov-filter-grid gov-filter-grid--groups"><label><span>关键词</span><Input allowClear prefix={<SearchOutlined />} placeholder="权限组名称或编号" value={keyword} onChange={(event) => setKeyword(event.target.value)} /></label><label><span>已引用流程</span><Select allowClear placeholder="全部流程" value={process} onChange={setProcess} options={[...new Set(groups.flatMap((group) => group.processes))].map((value) => ({ value }))} /></label><label><span>状态</span><Select allowClear placeholder="全部状态" value={status} onChange={setStatus} options={["启用", "停用"].map((value) => ({ value }))} /></label><div className="gov-filter-actions"><Button icon={<ReloadOutlined />} onClick={() => { setKeyword(""); setProcess(undefined); setStatus(undefined); }}>重置</Button></div></div></Card>
      <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}><ResultHeader title="流程权限组" count={filtered.length} extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor("new")}>新增权限组</Button>} /><Table<GroupRecord> rowKey="id" columns={columns} dataSource={filtered} scroll={{ x: 1400 }} pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 个权限组` }} /></Card>
      <Drawer width={720} open={editor !== null} onClose={() => confirmEditorClose(editorDirty, "流程权限组", () => { setEditorDirty(false); setEditor(null); })} title={editor === "new" ? "新增流程权限组" : "编辑流程权限组"} extra={<Space><Button onClick={() => confirmEditorClose(editorDirty, "流程权限组", () => { setEditorDirty(false); setEditor(null); })}>取消</Button><Button type="primary" onClick={() => form.submit()}>保存并立即生效</Button></Space>}>
        {editor !== "new" && editor?.openTasks ? <Alert className="gov-drawer-alert" type="warning" showIcon message={`当前有 ${editor.openTasks} 项运行待办`} description="保存后，新增成员立即获得处理资格；被移除成员将立即失去尚未处理的待办资格。" /> : null}
        <Form form={form} layout="vertical" onValuesChange={() => setEditorDirty(true)} onFinish={async (values) => {
          try {
            if (editor === "new") {
              cacheGroup(await flowPilotApi.directory.createGroup({ name: values.name, purposes: values.purposes, directMembers, linkedRoles, status: values.status ? "启用" : "停用" }));
            } else if (editor) {
              const resource = await flowPilotApi.directory.groupResource(editor.id);
              cacheGroup(await flowPilotApi.directory.updateGroup(editor.id, { name: values.name, purposes: values.purposes, directMembers, linkedRoles, status: values.status ? "启用" : "停用" }, resource.etag));
            }
            message.success("流程权限组已保存，成员资格已立即更新");
          } catch {
            message.error("流程权限组保存失败，请检查引用或刷新后重试");
            return;
          }
          setEditorDirty(false); setEditor(null);
        }}>
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
              <Checkbox.Group className="gov-purpose-checkboxes" options={(["发起", "审批/受理", "关闭"] satisfies GroupPurpose[]).map((value) => ({ label: value, value }))} />
            </Form.Item>
          </div>
          <div className="gov-group-editor-section"><div className="gov-section-title"><span><UserOutlined />直接成员</span><Tag>{directMemberUserIds.length} 人</Tag></div><Typography.Paragraph type="secondary">逐个加入的固定人员，不依赖其系统角色。</Typography.Paragraph><Form.Item name="directMemberUserIds"><Select mode="multiple" showSearch optionFilterProp="label" maxTagCount="responsive" options={identityUsers.filter((user) => !user.builtIn && user.status === "启用").map((user) => ({ value: user.id, label: `${user.name} · ${user.departmentPath}` }))} onChange={(values) => { setEditorDirty(true); setDirectMemberUserIds(values); }} /></Form.Item></div>
          <div className="gov-group-editor-section"><div className="gov-section-title"><span><TeamOutlined />关联角色</span><Tag>{linkedRoleIds.length} 个</Tag></div><Typography.Paragraph type="secondary">角色下的全部用户动态加入；角色成员变化会立即同步到本权限组。</Typography.Paragraph><Form.Item name="linkedRoleIds"><Select mode="multiple" showSearch optionFilterProp="label" options={identityRoles.filter((role) => !role.builtIn && role.status === "启用").map((role) => ({ value: role.id, label: role.name }))} onChange={(values) => { setEditorDirty(true); setLinkedRoleIds(values); }} /></Form.Item></div>
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
                const user = identityUsers.find((item) => item.name === name);
                const direct = user ? directMemberUserIds.includes(user.id) : false;
                const roles = identityRoles.filter((role) => linkedRoleIds.includes(role.id) && user?.roleIds?.includes(role.id)).map((role) => role.name);
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
        <div className="gov-member-list">{preview ? effectiveMembers(preview).map((name) => { const user = identityUsers.find((item) => item.name === name); const direct = user ? preview.directMemberUserIds?.includes(user.id) ?? false : false; const roles = identityRoles.filter((role) => preview.linkedRoleIds?.includes(role.id) && user?.roleIds?.includes(role.id)).map((role) => role.name); return <div className="gov-member-row" key={name}><PersonChip name={name} detail={user?.departmentPath} /><Space size={[4, 4]} wrap>{direct ? <Tag color="cyan">直接加入</Tag> : null}{roles.map((role) => <Tag color="purple" key={role}>角色带入：{role}</Tag>)}</Space></div>; }) : null}</div>
      </Drawer>
    </div>
  );
}

type InstanceMonitorStatus = "审核中" | "驳回待处理" | "已完成" | "已关闭" | "进行中";
interface MonitorRecord { id: string; code: string; title: string; process: string; version: string; status: InstanceMonitorStatus; node: string; initiator: string; department: string; createdAt: string; updatedAt: string; }
const monitorStatuses: InstanceMonitorStatus[] = ["审核中", "驳回待处理", "已完成", "已关闭", "进行中"];

export function InstanceMonitorPage() {
  const instances = usePrototypeStore((state) => state.instances);
  const definitions = useProcessDefinitionStore((state) => state.definitions);
  const [keyword, setKeyword] = useState("");
  const [process, setProcess] = useState<string>();
  const [status, setStatus] = useState<InstanceMonitorStatus>();
  const [dateRange, setDateRange] = useState(createDefaultDateRange);
  const [appliedFilters, setAppliedFilters] = useState(() => ({ keyword: "", process: undefined as string | undefined, status: undefined as InstanceMonitorStatus | undefined, dateRange: createDefaultDateRange() }));
  const [detail, setDetail] = useState<MonitorRecord | null>(null);
  const monitorRows = useMemo(() => instances.map((instance): MonitorRecord => {
    const definition = definitions.find((item) => item.id === instance.definitionId);
    const version = definition?.versions.find((item) => item.id === instance.versionId);
    const assignee = instance.currentAssigneeId ? findIdentityUser(instance.currentAssigneeId)?.name : instance.currentAssignee;
    return {
      id: instance.id,
      code: instance.code,
      title: instance.title,
      process: version?.basic.name ?? definition?.name ?? instance.template,
      version: version?.version ?? instance.templateVersion,
      status: instance.status,
      node: instance.status === "已完成" || instance.status === "已关闭"
        ? ""
        : instance.workflowType === "free" ? assignee ?? "" : instance.currentNode,
      initiator: instance.initiator,
      department: instance.department,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
    };
  }), [definitions, instances]);
  const filtered = monitorRows.filter((row) => `${row.code}${row.title}${row.initiator}`.toLowerCase().includes(appliedFilters.keyword.toLowerCase()) && (!appliedFilters.process || row.process === appliedFilters.process) && (!appliedFilters.status || row.status === appliedFilters.status) && isDateTimeInRange(row.createdAt, appliedFilters.dateRange));
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
      <Card className="query-card gov-query-card"><div className="gov-filter-grid gov-filter-grid--monitor"><label><span>关键词</span><Input allowClear prefix={<SearchOutlined />} placeholder="实例编号、标题或发起人" value={keyword} onChange={(event) => setKeyword(event.target.value)} onPressEnter={() => setAppliedFilters({ keyword, process, status, dateRange })} /></label><label><span>流程</span><Select allowClear placeholder="全部流程" value={process} onChange={setProcess} options={Array.from(new Set(monitorRows.map((row) => row.process))).map((value) => ({ value }))} /></label><label><span>状态</span><Select allowClear placeholder="全部状态" value={status} onChange={setStatus} options={monitorStatuses.map((value) => ({ value }))} /></label><label><span>发起时间</span><DatePicker.RangePicker allowClear={false} value={dateRange} onChange={(value) => { if (value?.[0] && value[1]) setDateRange(normalizeDayRange([value[0], value[1]])); }} /></label><div className="gov-filter-actions"><Button type="primary" icon={<SearchOutlined />} onClick={() => setAppliedFilters({ keyword, process, status, dateRange })}>查询</Button><Button icon={<ReloadOutlined />} onClick={() => { const nextRange = createDefaultDateRange(); setKeyword(""); setProcess(undefined); setStatus(undefined); setDateRange(nextRange); setAppliedFilters({ keyword: "", process: undefined, status: undefined, dateRange: nextRange }); }}>重置</Button></div></div></Card>
      <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}><ResultHeader title="流程实例" count={filtered.length} extra={<Typography.Text type="secondary"><LockOutlined /> 全部操作只读</Typography.Text>} /><Table<MonitorRecord> rowKey="id" columns={columns} dataSource={filtered} scroll={{ x: 1510 }} pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 条实例` }} /></Card>
      <Drawer width={660} open={Boolean(detail)} onClose={() => setDetail(null)} title="流程实例详情（只读）">
        {detail ? <><div className="gov-detail-hero-row"><span className="gov-detail-icon"><FileSearchOutlined /></span><div><Typography.Title level={4}>{detail.title}</Typography.Title><Typography.Text type="secondary">{detail.code} · {detail.process} {detail.version}</Typography.Text></div><StatusPill status={detail.status} /></div><Descriptions bordered column={2} size="small" items={[{ key: "initiator", label: "发起人", children: `${detail.initiator}（${detail.department}）` }, { key: "created", label: "发起时间", children: detail.createdAt }, { key: "node", label: "当前节点", children: detail.node || "—" }, { key: "updated", label: "更新时间", children: detail.updatedAt }]} /><div className="gov-detail-section"><div className="gov-section-title">流转概览</div><Timeline items={[{ color: "green", children: <><strong>{detail.initiator} 发起流程</strong><small>{detail.createdAt}</small></> }, { color: "blue", children: <><strong>进入 {detail.node || "结束"}</strong><small>{detail.updatedAt}</small></> }, { color: "gray", children: <Typography.Text type="secondary">后续流转记录将在这里按时间显示</Typography.Text> }]} /></div><Alert type="warning" showIcon message="只读限制" description="本页没有强制关闭、异常改派、跳过节点或修改表单的入口。" /></> : null}
      </Drawer>
    </div>
  );
}

type AuditResult = "成功" | "失败";
interface AuditRecord { id: string; operator: string; department: string; module: string; object: string; objectId: string; action: string; result: AuditResult; ip: string; time: string; before: string; after: string; detail: string; }

const auditModuleLabels: Record<string, string> = {
  authentication: "登录认证",
  definition: "流程定义",
  instance: "流程实例",
  task: "审批任务",
  identity: "组织权限",
};

const auditActionLabels: Record<string, string> = {
  create: "创建",
  pass: "通过",
  confirm: "确认",
  reject: "驳回",
  "revise-fields": "修改审核字段",
  "delete-version": "删除版本",
};

export function AuditLogPage() {
  const instances = usePrototypeStore((state) => state.instances);
  const tasks = usePrototypeStore((state) => state.tasks);
  const debugMode = isBrowserMockMode;
  const [remoteAuditEvents, setRemoteAuditEvents] = useState<AuditEvent[]>([]);
  const [keyword, setKeyword] = useState("");
  const [module, setModule] = useState<string>();
  const [result, setResult] = useState<AuditResult>();
  const [dateRange, setDateRange] = useState(createDefaultDateRange);
  const [appliedFilters, setAppliedFilters] = useState(() => ({ keyword: "", module: undefined as string | undefined, result: undefined as AuditResult | undefined, dateRange: createDefaultDateRange() }));
  const [detail, setDetail] = useState<AuditRecord | null>(null);
  useEffect(() => {
    if (debugMode) return;
    let cancelled = false;
    const load = async () => {
      const items: AuditEvent[] = [];
      for (let pageNumber = 1; ; pageNumber += 1) {
        const result = await flowPilotApi.audit.events({ page: pageNumber, pageSize: 100 });
        items.push(...result.items);
        if (pageNumber >= result.page.totalPages) break;
      }
      if (!cancelled) setRemoteAuditEvents(items);
    };
    void load().catch(() => {
      if (!cancelled) {
        setRemoteAuditEvents([]);
        message.error("审计日志加载失败，请稍后重试");
      }
    });
    return () => { cancelled = true; };
  }, [debugMode]);
  const auditRows = useMemo(() => {
    const eventsById = new Map(
      (debugMode
        ? [...readLocalAuditEvents(), ...collectRuntimeAuditEvents(instances, tasks)]
        : remoteAuditEvents).map((event) => [event.id, event]),
    );
    return Array.from(eventsById.values()).map((event): AuditRecord => {
      const actor = event.actorId ? findIdentityUser(event.actorId) : undefined;
      const details = event.details ? JSON.stringify(event.details, null, 2) : "—";
      return {
        id: event.id,
        operator: event.operatorName && event.operatorName !== event.actorName
          ? `${event.operatorName} → ${event.actorName ?? actor?.name ?? "未知用户"}`
          : event.actorName ?? actor?.name ?? "系统",
        department: actor?.departmentPath ?? "系统",
        module: auditModuleLabels[event.category] ?? event.category,
        object: event.summary,
        objectId: event.resourceId,
        action: auditActionLabels[event.action] ?? event.action,
        result: "成功",
        ip: "—",
        time: event.occurredAt.replace("T", " ").replace(/\.\d{3}Z$/, ""),
        before: "—",
        after: details,
        detail: event.summary,
      };
    }).sort((left, right) => Date.parse(right.time.replace(" ", "T")) - Date.parse(left.time.replace(" ", "T")));
  }, [debugMode, instances, remoteAuditEvents, tasks]);
  const filtered = auditRows.filter((row) => `${row.operator}${row.object}${row.objectId}${row.ip}`.toLowerCase().includes(appliedFilters.keyword.toLowerCase()) && (!appliedFilters.module || row.module === appliedFilters.module) && (!appliedFilters.result || row.result === appliedFilters.result) && isDateTimeInRange(row.time, appliedFilters.dateRange));
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
      <Card className="query-card gov-query-card"><div className="gov-filter-grid gov-filter-grid--audit"><label><span>关键词</span><Input allowClear prefix={<SearchOutlined />} placeholder="操作人、对象、编号或 IP" value={keyword} onChange={(event) => setKeyword(event.target.value)} onPressEnter={() => setAppliedFilters({ keyword, module, result, dateRange })} /></label><label><span>模块</span><Select allowClear placeholder="全部模块" value={module} onChange={setModule} options={Array.from(new Set(auditRows.map((row) => row.module))).map((value) => ({ value }))} /></label><label><span>结果</span><Select allowClear placeholder="全部结果" value={result} onChange={setResult} options={["成功", "失败"].map((value) => ({ value }))} /></label><label><span>操作时间</span><DatePicker.RangePicker allowClear={false} showTime value={dateRange} onChange={(value) => { if (value?.[0] && value[1]) setDateRange([value[0], value[1]]); }} /></label><div className="gov-filter-actions"><Button type="primary" icon={<SearchOutlined />} onClick={() => setAppliedFilters({ keyword, module, result, dateRange })}>查询</Button><Button icon={<ReloadOutlined />} onClick={() => { const nextRange = createDefaultDateRange(); setKeyword(""); setModule(undefined); setResult(undefined); setDateRange(nextRange); setAppliedFilters({ keyword: "", module: undefined, result: undefined, dateRange: nextRange }); }}>重置</Button></div></div></Card>
      <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}><ResultHeader title="操作审计" count={filtered.length} extra={<Typography.Text type="secondary">审计记录只读且不可删除</Typography.Text>} /><Table<AuditRecord> rowKey="id" columns={columns} dataSource={filtered} scroll={{ x: 1240 }} pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 条日志` }} /></Card>
      <Drawer width={680} open={Boolean(detail)} onClose={() => setDetail(null)} title="审计详情">
        {detail ? <><div className="gov-audit-detail-head"><span className={`gov-audit-result is-${detail.result === "成功" ? "success" : "error"}`}>{detail.result === "成功" ? <CheckCircleOutlined /> : <StopOutlined />}</span><div><Typography.Title level={4}>{detail.action}</Typography.Title><Typography.Text type="secondary">{detail.id} · {detail.time}</Typography.Text></div><StatusPill status={detail.result} /></div><Descriptions bordered column={2} size="small" items={[{ key: "operator", label: "操作人", children: `${detail.operator}（${detail.department}）` }, { key: "ip", label: "IP 地址", children: detail.ip }, { key: "module", label: "模块", children: detail.module }, { key: "objectId", label: "对象编号", children: detail.objectId }, { key: "object", label: "操作对象", span: 2, children: detail.object }]} /><div className="gov-audit-values"><div><span>变更前</span><pre>{detail.before}</pre></div><div><span>变更后</span><pre>{detail.after}</pre></div></div><Alert type="info" showIcon message="操作说明" description={detail.detail} /></> : null}
      </Drawer>
    </div>
  );
}
