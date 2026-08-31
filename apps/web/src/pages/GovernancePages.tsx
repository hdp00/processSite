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
  Pagination,
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
  defaultRolePermissionMap,
  hasPersonaPermission,
  normalizeRolePermissionList,
  notifyRolePermissionsChanged,
  readStoredRolePermissions,
} from "../state/rolePermissions";
import { permissionCatalogPages } from "../data/permissionCatalog";
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
import { compareDomainTimestamps, formatDisplayDateTime } from "../utils/domainTime";
import { collectRuntimeAuditEvents } from "../utils/runtimeAudit";
import { isBrowserMockMode } from "../utils/runtimeMode";
import { auditActionLabel, auditDetailText, auditModuleLabel, auditResultLabel, auditSummaryText } from "../utils/auditDisplay";
import { deriveAllWorkflowGroupStatistics } from "../state/workflowGroupStatistics";
import { flowPilotApi } from "../api/flowPilotApi";
import type { AuditEvent, EffectiveWorkflowMember } from "../api/contracts";
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

function useDirectoryUserCandidates(keyword: string, active: boolean, selectedIds: string[] = []) {
  const mockUsers = useIdentityStore((state) => state.users);
  const [remoteUsers, setRemoteUsers] = useState<UserRecord[]>([]);
  const selectedKey = selectedIds.join(",");
  useEffect(() => {
    if (isBrowserMockMode || !active) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void Promise.all([
        flowPilotApi.directory.users({ page: 1, pageSize: 100, q: keyword.trim() || undefined, status: "启用" }),
        ...selectedIds.map((id) => flowPilotApi.directory.user(id).catch(() => undefined)),
      ]).then(([page, ...selected]) => {
        if (cancelled) return;
        const byId = new Map<string, UserRecord>();
        [...page.items, ...selected].forEach((user) => {
          if (user) byId.set(user.id, { ...user, password: "" });
        });
        setRemoteUsers([...byId.values()]);
      }).catch(() => {
        if (!cancelled) message.error("人员候选加载失败，请重试");
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, keyword, selectedKey]);
  return isBrowserMockMode ? mockUsers : remoteUsers;
}

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
      <div><strong>{title}</strong><Tag variant="filled">{count} 条</Tag></div>
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
  const personaId = usePrototypeStore((state) => state.personaId);
  const canEditUsers = hasPersonaPermission(personaId, "org-user:编辑");
  const canResetPasswords = hasPersonaPermission(personaId, "org-user:重置密码");
  const canDeleteUsers = hasPersonaPermission(personaId, "org-user:删除");
  const departmentOptions = useMemo(() => departmentCascaderOptions(departments), [departments]);
  const [draftFilters, setDraftFilters] = useState({ keyword: "", department: [] as string[], jobTitle: "", role: "", status: "" });
  const [filters, setFilters] = useState(draftFilters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [remoteRows, setRemoteRows] = useState<UserRecord[]>([]);
  const [remoteTotal, setRemoteTotal] = useState(0);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [drawerUser, setDrawerUser] = useState<UserRecord | "new" | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorEtag, setEditorEtag] = useState<string>();
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
  const cacheVisibleUser = (user: Omit<UserRecord, "password">) => {
    cacheUser(user);
    setRemoteRows((rows) => {
      const current = rows.find((item) => item.id === user.id);
      const next = { ...current, ...user, password: current?.password ?? "" } as UserRecord;
      return current ? rows.map((item) => item.id === user.id ? next : item) : [next, ...rows].slice(0, pageSize);
    });
  };
  const changeUserStatus = async (record: UserRecord) => {
    try {
      const resource = await flowPilotApi.directory.userResource(record.id);
      const updated = await flowPilotApi.directory.updateUserStatus(
        record.id,
        record.status === "启用" ? "停用" : "启用",
        resource.etag ?? "*",
      );
      cacheVisibleUser(updated);
      message.success(`账号已${updated.status}`);
    } catch {
      message.error("账号状态更新失败，请刷新后重试");
    }
  };
  const resetUserPassword = async (record: UserRecord) => {
    let nextPassword = "";
    Modal.confirm({
      title: `重置 ${record.name} 的密码`,
      content: <div style={{ marginTop: 16 }}><Typography.Paragraph type="secondary">请输入新密码。保存后旧密码立即失效。</Typography.Paragraph><Input.Password autoFocus placeholder="新密码" onChange={(event) => { nextPassword = event.target.value; }} /></div>,
      okText: "确认重置",
      cancelText: "取消",
      onOk: async () => {
        if (!nextPassword) throw new Error("请输入新密码");
        try {
          const resource = await flowPilotApi.directory.userResource(record.id);
          const result = await flowPilotApi.directory.resetPassword(record.id, nextPassword, resource.etag);
          message.success(result.temporaryPassword
            ? `已为 ${record.name} 生成临时密码：${result.temporaryPassword}`
            : `${record.name} 的密码已重置`);
        } catch (error) {
          message.error(error instanceof Error ? error.message : "密码重置失败，请稍后重试");
          throw error;
        }
      },
    });
  };
  const deleteUser = (record: UserRecord) => {
    Modal.confirm({
      title: `删除用户 ${record.name}？`,
      content: "删除前会检查角色、流程权限组、流程版本、实例、任务和附件等引用。存在任何引用时将阻止删除，历史业务用户请改为停用。",
      okText: "检查并删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          const resource = await flowPilotApi.directory.userResource(record.id);
          await flowPilotApi.directory.deleteUser(record.id, resource.etag ?? "*");
          setUsers((rows) => rows.filter((user) => user.id !== record.id));
          setRemoteRows((rows) => rows.filter((user) => user.id !== record.id));
          if (!isBrowserMockMode) setRemoteTotal((total) => Math.max(0, total - 1));
          message.success(`用户 ${record.name} 已删除`);
        } catch (error) {
          message.error(error instanceof Error ? error.message : "用户删除失败，请刷新后重试");
        }
      },
    });
  };

  const roleOptions = roles.map((role) => role.name);
  const assignableRoleOptions = roles.filter((role) => !role.builtIn && role.status === "启用").map((role) => role.name);
  const managerTitleName = jobTitles.find((item) => item.id === "JOB-001")?.name;
  const drawerJobTitle = drawerUser !== "new" ? drawerUser?.jobTitle : undefined;
  const selectableJobTitles = jobTitles
    .filter((item) => item.status === "启用" || item.name === drawerJobTitle)
    .sort((a, b) => a.sort - b.sort);

  useEffect(() => {
    if (isBrowserMockMode) return;
    let cancelled = false;
    setRemoteLoading(true);
    const positionId = jobTitles.find((item) => item.name === filters.jobTitle)?.id;
    const roleId = roles.find((item) => item.name === filters.role)?.id;
    void flowPilotApi.directory.users({
      page,
      pageSize,
      q: filters.keyword || undefined,
      departmentId: filters.department.at(-1),
      positionId,
      roleId,
      status: filters.status === "启用" || filters.status === "停用" ? filters.status : undefined,
    }).then((result) => {
      if (cancelled) return;
      const rows = result.items.map((user) => ({ ...user, password: "" }));
      setRemoteRows(rows);
      setRemoteTotal(result.page.totalElements);
      setUsers((current) => {
        const byId = new Map(current.map((user) => [user.id, user]));
        rows.forEach((user) => byId.set(user.id, { ...byId.get(user.id), ...user }));
        return [...byId.values()];
      });
    }).catch(() => {
      if (!cancelled) message.error("用户列表加载失败，请重试");
    }).finally(() => {
      if (!cancelled) setRemoteLoading(false);
    });
    return () => { cancelled = true; };
  }, [filters, jobTitles, page, pageSize, roles, setUsers]);

  const filtered = useMemo(() => (isBrowserMockMode ? users : remoteRows).filter((user) => {
    if (!isBrowserMockMode) return true;
    const keyword = filters.keyword.trim().toLowerCase();
    const matchesKeyword = !keyword || `${user.account}${user.name}${user.email}`.toLowerCase().includes(keyword);
    const matchesDepartment = !filters.department.length || filters.department.every((value, index) => user.department[index] === value);
    return matchesKeyword && matchesDepartment && (!filters.jobTitle || user.jobTitle === filters.jobTitle)
      && (!filters.role || user.roles.includes(filters.role)) && (!filters.status || user.status === filters.status);
  }), [filters, remoteRows, users]);
  const pageRows = isBrowserMockMode ? filtered.slice((page - 1) * pageSize, page * pageSize) : filtered;
  const resultTotal = isBrowserMockMode ? filtered.length : remoteTotal;
  const summaryUsers = isBrowserMockMode ? users : remoteRows;

  const openEditor = (user: UserRecord | "new") => {
    if (user !== "new" && user.builtIn) {
      message.info("超级管理员是系统内置账号，不允许修改");
      return;
    }
    setDrawerUser(user);
    setEditorEtag(undefined);
    setEditorDirty(false);
    form.resetFields();
    form.setFieldsValue(user === "new" ? {
      account: "", email: "", name: "", authenticationMode: "domain", password: "", newPassword: "", department: [], jobTitle: undefined, roles: [], status: true,
    } : { ...user, newPassword: "" });
    if (user !== "new") {
      void flowPilotApi.directory.userResource(user.id).then((resource) => setEditorEtag(resource.etag)).catch(() => message.error("用户最新版本加载失败，请刷新后重试"));
    }
  };

  const columns: TableProps<UserRecord>["columns"] = [
    { title: "用户", dataIndex: "name", width: 190, fixed: "left", render: (_, record) => <Space size={6}><PersonChip name={record.name} detail={record.account} />{record.builtIn ? <Tag color="gold" icon={<LockOutlined />}>内置</Tag> : null}</Space> },
    { title: "邮箱", dataIndex: "email", width: 220, ellipsis: true, render: (value: string) => value || "—" },
    { title: "登录方式", dataIndex: "authenticationMode", width: 106, render: (mode: AuthenticationMode) => <Tag color={mode === "domain" ? "blue" : "default"}>{authenticationModeLabel[mode]}</Tag> },
    { title: "部门", dataIndex: "departmentPath", width: 160, ellipsis: true, render: (value: string) => value || "—" },
    { title: "职务", dataIndex: "jobTitle", width: 100, render: (value: JobTitle) => value ? <Tag color={value === managerTitleName ? "purple" : "default"}>{value}</Tag> : "—" },
    { title: "角色（可多选）", dataIndex: "roles", width: 260, render: (roles: string[]) => roles.length ? <Space size={[4, 4]} wrap>{roles.map((role) => <Tag key={role} color={role === "超级管理员" ? "gold" : role === "流程管理员" ? "blue" : undefined}>{role}</Tag>)}</Space> : "—" },
    { title: "状态", dataIndex: "status", width: 88, render: (status: EnableStatus) => <StatusTag status={status} /> },
    { title: "最近登录", dataIndex: "lastLogin", width: 154, render: (value: string) => formatDisplayDateTime(value) },
    {
      title: "操作", fixed: "right", width: 184, align: "center",
      render: (_, record) => (
        <Space size={4}>
          {canEditUsers && <Tooltip title={record.builtIn ? "系统内置账号不可编辑" : "编辑用户"}><Button disabled={record.builtIn} type="text" aria-label={`编辑用户：${record.name}`} icon={<EditOutlined />} onClick={() => openEditor(record)} /></Tooltip>}
          {canEditUsers && <Tooltip title={record.status === "启用" ? "停用账号" : "启用账号"}>
            <Popconfirm disabled={record.builtIn} title={`确认${record.status === "启用" ? "停用" : "启用"} ${record.name}？`} onConfirm={() => void changeUserStatus(record)}><Button disabled={record.builtIn} type="text" aria-label={`${record.status === "启用" ? "停用" : "启用"}用户：${record.name}`} icon={record.status === "启用" ? <StopOutlined /> : <CheckCircleOutlined />} /></Popconfirm>
          </Tooltip>}
          {canResetPasswords && <Tooltip title={record.builtIn ? "系统内置账号密码不可在此重置" : record.authenticationMode === "domain" ? "域登录密码由域系统维护" : "重置密码"}><Button disabled={record.builtIn || record.authenticationMode === "domain"} type="text" aria-label={`重置密码：${record.name}`} icon={<KeyOutlined />} onClick={() => void resetUserPassword(record)} /></Tooltip>}
          {canDeleteUsers && <Tooltip title={record.builtIn ? "系统内置账号不可删除" : "删除用户"}><Button danger disabled={record.builtIn} type="text" aria-label={`删除用户：${record.name}`} icon={<DeleteOutlined />} onClick={() => deleteUser(record)} /></Tooltip>}
        </Space>
      ),
    },
  ];

  return (
    <div className="page-stack gov-page">
      {userEditorGuard}
      <SummaryStrip items={[
        { label: "用户总数", value: isBrowserMockMode ? users.length : remoteTotal, note: "按服务端分页加载" },
        { label: "启用账号", value: summaryUsers.filter((item) => item.status === "启用").length, note: isBrowserMockMode ? "可正常登录" : "当前页", tone: "green" },
        { label: "多角色用户", value: summaryUsers.filter((item) => item.roles.length > 1).length, note: isBrowserMockMode ? "权限取角色并集" : "当前页", tone: "blue" },
        { label: "域登录账号", value: summaryUsers.filter((item) => item.authenticationMode === "domain").length, note: isBrowserMockMode ? "普通用户默认方式" : "当前页" },
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
        <ResultHeader title="用户列表" count={resultTotal} extra={<><Typography.Text type="secondary">仅加载当前页数据</Typography.Text>{canEditUsers && <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor("new")}>新增用户</Button>}</>} />
        <Table<UserRecord> loading={remoteLoading} rowKey="id" columns={columns} dataSource={pageRows} scroll={{ x: 1420 }} pagination={{ current: page, pageSize, total: resultTotal, showSizeChanger: true, pageSizeOptions: [10, 20, 50], showTotal: (total) => `共 ${total} 名用户`, onChange: (nextPage, nextPageSize) => { setPage(nextPageSize === pageSize ? nextPage : 1); setPageSize(nextPageSize); } }} />
      </Card>
      <Drawer width={600} open={drawerUser !== null} onClose={() => confirmEditorClose(editorDirty, "用户信息", () => { setEditorDirty(false); setDrawerUser(null); })} title={drawerUser === "new" ? "新增用户" : "编辑用户"} extra={<Space><Button onClick={() => confirmEditorClose(editorDirty, "用户信息", () => { setEditorDirty(false); setDrawerUser(null); })}>取消</Button><Button type="primary" onClick={() => form.submit()}>保存</Button></Space>}>
        <Alert
          className="gov-drawer-alert"
          type="info"
          showIcon
          title={drawerUser === "new" ? "普通用户默认使用域登录" : "可调整普通用户的登录方式"}
          description={drawerUser === "new" ? "域登录不设置本地密码；密码登录必须填写初始密码。部门、职务和角色均可留空。" : "切换为密码登录时需要设置新密码；部门、职务和角色均可留空。账号状态仍通过列表操作处理。"}
        />
        <Form form={form} layout="vertical" requiredMark="optional" onValuesChange={() => setEditorDirty(true)} onFinish={async (values) => {
          const department = Array.isArray(values.department) ? values.department : [];
          const rootDepartment = departmentOptions.find((item) => item.value === department[0]);
          const childDepartment = rootDepartment?.children?.find((item) => item.value === department[1]);
          const path = department.length === 0 ? "" : department.length === 1 ? rootDepartment?.label ?? "" : `${rootDepartment?.label ?? ""} / ${childDepartment?.label ?? ""}`;
          try {
            if (drawerUser === "new") {
              const created = await flowPilotApi.directory.createUser({ account: values.account, email: String(values.email).trim(), authenticationMode: values.authenticationMode, password: values.authenticationMode === "password" ? values.password : undefined, name: values.name, department: values.department, departmentPath: String(path), jobTitle: values.jobTitle, roles: values.roles, status: values.status ? "启用" : "停用" });
              cacheVisibleUser(created);
              message.success("用户已创建");
            } else if (drawerUser) {
              if (!editorEtag) throw new Error("用户最新版本尚未加载完成");
              const updated = await flowPilotApi.directory.updateUser(drawerUser.id, { email: String(values.email).trim(), authenticationMode: values.authenticationMode, newPassword: drawerUser.authenticationMode === "domain" && values.authenticationMode === "password" ? values.newPassword : undefined, name: values.name, department: values.department, departmentPath: String(path), jobTitle: values.jobTitle, roles: values.roles }, editorEtag);
              cacheVisibleUser(updated);
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
            <Form.Item name="account" label="登录账号" rules={[{ required: true, message: "请输入登录账号" }, { validator: (_, value) => String(value ?? "").trim().toLowerCase() === "superadmin" ? Promise.reject(new Error("该账号由系统内置，不能创建或修改")) : Promise.resolve() }]}><Input disabled={drawerUser !== "new"} maxLength={40} /></Form.Item>
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
          {drawerUser === "new" && selectedAuthenticationMode === "password" && <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 1, message: "密码至少 1 个字符" }]} extra="仅密码登录用户需要设置；正式后端使用 Node.js scrypt 保存版本化散列。"><Input.Password maxLength={64} /></Form.Item>}
          {drawerUser !== "new" && drawerUser?.authenticationMode === "domain" && selectedAuthenticationMode === "password" && <Form.Item name="newPassword" label="新密码" rules={[{ required: true, min: 1, message: "切换为密码登录时必须设置新密码" }]}><Input.Password maxLength={64} /></Form.Item>}
          <Form.Item name="department" label="所属部门" extra="可留空，也可选择一级或二级部门。"><Cascader changeOnSelect showSearch allowClear options={departmentOptions} placeholder="未设置" /></Form.Item>
          {drawerUser === "new" ? <div className="gov-form-grid">
            <Form.Item name="jobTitle" label="职务"><Select allowClear placeholder="未设置" options={selectableJobTitles.map((item) => ({ value: item.name, label: item.status === "停用" ? `${item.name}（已停用，仅保留历史）` : item.name }))} /></Form.Item>
            <Form.Item name="status" label="初始账号状态" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="停用" /></Form.Item>
          </div> : <Form.Item name="jobTitle" label="职务"><Select allowClear placeholder="未设置" options={selectableJobTitles.map((item) => ({ value: item.name, label: item.status === "停用" ? `${item.name}（已停用，仅保留历史）` : item.name }))} /></Form.Item>}
          <Form.Item
            name="roles"
            label="系统角色"
            extra="角色可留空；超级管理员角色不能分配给其他用户。"
          ><Select mode="multiple" showSearch optionFilterProp="label" maxTagCount="responsive" options={assignableRoleOptions.map((value) => ({ value, label: value }))} /></Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}

export function DepartmentManagementPage() {
  const confirmEditorClose = useCloseEditorConfirmation();
  const personaId = usePrototypeStore((state) => state.personaId);
  const canEditOrganization = hasPersonaPermission(personaId, "org-department:编辑");
  const canDeleteOrganization = hasPersonaPermission(personaId, "org-department:删除");
  const [section, setSection] = useState<"departments" | "jobTitles">("departments");
  const storedDepartments = useOrganizationStore((state) => state.departments);
  const setDepartments = useOrganizationStore((state) => state.setDepartments);
  const storedJobTitles = useOrganizationStore((state) => state.jobTitles);
  const setJobTitles = useOrganizationStore((state) => state.setJobTitles);
  const identityUsers = useIdentityStore((state) => state.users);
  const departments = useMemo(() => storedDepartments.map((department) => {
    const users = isBrowserMockMode
      ? identityUsers.filter((user) => user.department.includes(department.key)).length
      : department.users;
    return { ...department, users, referenced: users > 0 };
  }), [identityUsers, storedDepartments]);
  const jobTitles = useMemo(() => storedJobTitles.map((jobTitle) => ({
    ...jobTitle,
    users: isBrowserMockMode
      ? identityUsers.filter((user) => user.jobTitle === jobTitle.name).length
      : jobTitle.users,
  })), [identityUsers, storedJobTitles]);
  const [selectedKey, setSelectedKey] = useState("rd");
  const [editor, setEditor] = useState<{ mode: "new-root" | "new-child" | "edit"; record?: DepartmentRecord } | null>(null);
  const [jobTitleEditor, setJobTitleEditor] = useState<JobTitleRecord | "new" | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [departmentEtag, setDepartmentEtag] = useState<string>();
  const [jobTitleEtag, setJobTitleEtag] = useState<string>();
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
    } catch (error) {
      message.error(error instanceof Error ? error.message : "部门删除失败，请确认没有用户或下级部门引用");
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
    } catch (error) {
      message.error(error instanceof Error ? error.message : "职务删除失败，请确认没有用户引用");
    }
  };

  const selected = departments.find((item) => item.key === selectedKey) ?? departments[0];
  const treeData = departments.filter((item) => item.level === 1).sort((a, b) => a.sort - b.sort).map((root) => ({
    key: root.key,
    title: <span className="gov-tree-title"><span>{root.name}</span><Tag variant="filled">{root.users} 人</Tag>{root.status === "停用" ? <StatusPill status="停用" compact /> : null}</span>,
    children: departments.filter((item) => item.parentKey === root.key).sort((a, b) => a.sort - b.sort).map((child) => ({ key: child.key, title: <span className="gov-tree-title"><span>{child.name}</span><Tag variant="filled">{child.users} 人</Tag>{child.status === "停用" ? <StatusPill status="停用" compact /> : null}</span> })),
  }));
  const openDepartmentEditor = (mode: "new-root" | "new-child" | "edit") => {
    if (mode !== "new-root" && !selected) return;
    const record = mode === "edit" ? selected : undefined;
    setEditor({ mode, record });
    setDepartmentEtag(undefined);
    setEditorDirty(false);
    form.setFieldsValue(record ? { ...record, status: record.status === "启用" } : { name: "", sort: 10, status: true, description: "" });
    if (record) {
      void flowPilotApi.organization.department(record.key).then((resource) => setDepartmentEtag(resource.etag)).catch(() => message.error("部门最新版本加载失败"));
    }
  };
  const openJobTitleEditor = (record: JobTitleRecord | "new") => {
    setJobTitleEditor(record);
    setJobTitleEtag(undefined);
    setEditorDirty(false);
    jobTitleForm.resetFields();
    jobTitleForm.setFieldsValue(record === "new"
      ? { name: "", sort: Math.max(0, ...jobTitles.map((item) => item.sort)) + 10, status: true, description: "" }
      : { ...record, status: record.status === "启用" });
    if (record !== "new") {
      void flowPilotApi.organization.position(record.id).then((resource) => setJobTitleEtag(resource.etag)).catch(() => message.error("职务最新版本加载失败"));
    }
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
      render: (_, record) => canEditOrganization || canDeleteOrganization ? <Space size={4}>
        {canEditOrganization && <Tooltip title="编辑职务"><Button type="text" aria-label={`编辑职务：${record.name}`} icon={<EditOutlined />} onClick={() => openJobTitleEditor(record)} /></Tooltip>}
        {canEditOrganization && <Tooltip title={record.status === "启用" ? "停用职务" : "启用职务"}><Button type="text" aria-label={`${record.status === "启用" ? "停用" : "启用"}职务：${record.name}`} icon={record.status === "启用" ? <StopOutlined /> : <CheckCircleOutlined />} onClick={() => void changePositionStatus(record)} /></Tooltip>}
        {canDeleteOrganization && <Tooltip title={record.users ? "已有用户使用，不能删除" : "删除职务"}><Popconfirm disabled={record.users > 0} title="确认删除这个职务？" onConfirm={() => void deletePosition(record)}><Button type="text" danger disabled={record.users > 0} aria-label={`删除职务：${record.name}`} icon={<DeleteOutlined />} /></Popconfirm></Tooltip>}
      </Space> : null,
    },
  ];

  return (
    <div className="page-stack gov-page">
      {organizationEditorGuard}
      <Card className="gov-org-section-switch" variant="borderless">
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
      <Alert showIcon type="info" title="部门层级最多两级" description="用户可以归属一级或二级部门。一级部门可以没有子部门；二级部门不能继续添加下级。引用中的部门不可删除，但可以停用。" />
      <div className="gov-split-layout gov-department-layout">
        <Card className="content-card gov-tree-card" title={<Space><ApartmentOutlined />组织架构</Space>} extra={canEditOrganization ? <Button type="text" icon={<PlusOutlined />} onClick={() => openDepartmentEditor("new-root")}>新增一级部门</Button> : null}>
          <Input allowClear prefix={<SearchOutlined />} placeholder="搜索部门" className="gov-tree-search" />
          <Tree blockNode defaultExpandAll selectedKeys={[selectedKey]} treeData={treeData} onSelect={(keys) => keys[0] && setSelectedKey(String(keys[0]))} />
        </Card>
        <Card className="content-card gov-detail-card" title="部门详情" extra={canEditOrganization && selected ? <Space><Button icon={<EditOutlined />} onClick={() => openDepartmentEditor("edit")}>编辑</Button><Button type="primary" icon={<PlusOutlined />} disabled={selected.level === 2} onClick={() => openDepartmentEditor("new-child")}>添加下级</Button></Space> : null}>
          {selected ? <>
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
            <Alert type={selected.referenced ? "warning" : "success"} showIcon title={selected.referenced ? "该部门已有用户或历史流程引用，不允许删除" : "当前部门尚未被引用，可以删除"} description="停用后不能再分配给新用户；现有用户与历史数据仍保留该部门路径，待管理员完成迁移。" />
            {(canEditOrganization || canDeleteOrganization) && <Space>
              {canEditOrganization && <Popconfirm title={`确认${selected.status === "启用" ? "停用" : "启用"}此部门？`} onConfirm={() => void changeDepartmentStatus(selected)}><Button icon={selected.status === "启用" ? <StopOutlined /> : <CheckCircleOutlined />}>{selected.status === "启用" ? "停用部门" : "启用部门"}</Button></Popconfirm>}
              {canDeleteOrganization && <Popconfirm disabled={selected.referenced} title="确认删除此部门？" onConfirm={() => void deleteDepartment(selected)}><Button danger disabled={selected.referenced} icon={<DeleteOutlined />}>删除部门</Button></Popconfirm>}
            </Space>}
          </div>
          </> : <Alert showIcon type="info" title="暂无部门" description="当前可以不维护部门；需要使用部门时再新增即可。" />}
        </Card>
      </div>
      </> : <>
        <Alert showIcon type="info" title="职务是全局组织字典" description="职务不绑定具体部门。停用后不能再分配给新用户，已有用户保留历史职务；只有未被任何用户使用的职务才可以删除。" />
        <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}>
          <ResultHeader title="职务列表" count={jobTitles.length} extra={canEditOrganization ? <Button type="primary" icon={<PlusOutlined />} onClick={() => openJobTitleEditor("new")}>新增职务</Button> : null} />
          <Table<JobTitleRecord> rowKey="id" columns={jobTitleColumns} dataSource={[...jobTitles].sort((a, b) => a.sort - b.sort)} scroll={{ x: 850 }} pagination={false} />
        </Card>
      </>}
      <Drawer width={520} open={section === "departments" && editor !== null} onClose={() => confirmEditorClose(editorDirty, "部门信息", () => { setEditorDirty(false); setEditor(null); })} title={editor?.mode === "edit" ? "编辑部门" : editor?.mode === "new-child" ? `在“${selected?.name ?? ""}”下新增二级部门` : "新增一级部门"} extra={<Space><Button onClick={() => confirmEditorClose(editorDirty, "部门信息", () => { setEditorDirty(false); setEditor(null); })}>取消</Button><Button type="primary" onClick={() => form.submit()}>保存</Button></Space>}>
        {editor?.mode === "new-child" && selected?.level === 2 ? <Alert type="error" showIcon title="二级部门不能继续添加下级" /> : null}
        <Form form={form} layout="vertical" onValuesChange={() => setEditorDirty(true)} onFinish={async (values) => {
          try {
            if (editor?.mode === "edit") {
              if (!selected) throw new Error("未选择部门");
              if (!departmentEtag) throw new Error("部门最新版本尚未加载完成");
              const saved = await flowPilotApi.organization.updateDepartment(selected.key, { name: values.name, sortOrder: values.sort, status: values.status ? "启用" : "停用", description: values.description }, departmentEtag);
              cacheDepartment(saved);
              message.success("部门信息已保存");
            } else {
              const isChild = editor?.mode === "new-child";
              if (isChild && !selected) throw new Error("未选择上级部门");
              const saved = await flowPilotApi.organization.createDepartment({ name: values.name, parentId: isChild ? selected!.key : undefined, sortOrder: values.sort, description: values.description });
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
        {jobTitleEditor !== "new" && jobTitleEditor?.users ? <Alert className="gov-drawer-alert" type="info" showIcon title={`当前有 ${jobTitleEditor.users} 名用户使用该职务`} description="可以修改名称、排序、状态和说明；名称修改后所有关联用户同步显示新名称，但该职务不能直接删除。" /> : null}
        <Form form={jobTitleForm} layout="vertical" onValuesChange={() => setEditorDirty(true)} onFinish={async (values) => {
          try {
            if (jobTitleEditor === "new") {
              cachePosition(await flowPilotApi.organization.createPosition({ name: values.name.trim(), description: values.description, sortOrder: values.sort }));
              message.success("职务已新增");
            } else if (jobTitleEditor) {
              if (!jobTitleEtag) throw new Error("职务最新版本尚未加载完成");
              cachePosition(await flowPilotApi.organization.updatePosition(jobTitleEditor.id, { name: values.name.trim(), description: values.description, status: values.status ? "启用" : "停用", sortOrder: values.sort }, jobTitleEtag));
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
  const storedRoles = useIdentityStore((state) => state.roles);
  const roles = useMemo(
    () => isBrowserMockMode ? applyRolePermissionStats(storedRoles, readStoredRolePermissions()) : storedRoles,
    [storedRoles],
  );
  const setRoles = useIdentityStore((state) => state.setRoles);
  const identityUsers = useIdentityStore((state) => state.users);
  const organizationJobTitles = useOrganizationStore((state) => state.jobTitles);
  const personaId = usePrototypeStore((state) => state.personaId);
  const canEditRoles = hasPersonaPermission(personaId, "org-role:编辑");
  const canGrantRoles = hasPersonaPermission(personaId, "org-role:授权");
  const canDeleteRoles = hasPersonaPermission(personaId, "org-role:删除");
  const [keyword, setKeyword] = useState("");
  const [editor, setEditor] = useState<RoleRecord | "new" | null>(null);
  const [memberRole, setMemberRole] = useState<RoleRecord | null>(null);
  const [memberKeyword, setMemberKeyword] = useState("");
  const [editingMemberIds, setEditingMemberIds] = useState<string[]>([]);
  const [roleMemberKeyword, setRoleMemberKeyword] = useState("");
  const [roleMemberView, setRoleMemberView] = useState<"all" | "selected">("all");
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorEtag, setEditorEtag] = useState<string>();
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
  const confirmRoleChange = async (roleId: string, nextMemberIds: string[], nextStatus: EnableStatus) => {
    const impact = await flowPilotApi.organization.roleImpact(roleId, nextMemberIds, nextStatus);
    if (impact.affectedUsers === 0 && impact.affectedOpenTasks === 0) return true;
    const userNames = impact.references.length > 0 ? `涉及成员：${impact.references.slice(0, 5).join("、")}${impact.references.length > 5 ? "等" : ""}。` : "";
    return new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: "确认保存角色变更？",
        content: `变更后将有 ${impact.affectedUsers} 人失去流程权限组资格，影响 ${impact.affectedOpenTasks} 个未完成待办。${userNames}`,
        okText: "确认变更",
        cancelText: "取消",
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  };
  const changeRoleStatus = async (record: RoleRecord) => {
    try {
      const nextStatus = record.status === "启用" ? "停用" : "启用";
      if (!await confirmRoleChange(record.id, record.memberUserIds ?? [], nextStatus)) return;
      const resource = await flowPilotApi.directory.roleResource(record.id);
      cacheRole(await flowPilotApi.directory.updateRole(
        record.id,
        { status: nextStatus },
        resource.etag,
      ));
      message.success(`角色已${record.status === "启用" ? "停用" : "启用"}`);
    } catch {
      message.error("角色状态更新失败，请刷新后重试");
    }
  };
  const deleteRole = (record: RoleRecord) => {
    Modal.confirm({
      title: `删除角色 ${record.name}？`,
      content: "删除前会检查用户成员、流程权限组和所有流程版本引用。存在任何引用时将阻止删除，历史业务角色请改为停用。",
      okText: "检查并删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          const resource = await flowPilotApi.directory.roleResource(record.id);
          await flowPilotApi.directory.deleteRole(record.id, resource.etag ?? "*");
          setRoles((rows) => rows.filter((role) => role.id !== record.id));
          message.success(`角色 ${record.name} 已删除`);
        } catch (error) {
          message.error(error instanceof Error ? error.message : "角色删除失败，请刷新后重试");
        }
      },
    });
  };
  const filtered = roles.filter((role) => `${role.name}${role.description}`.toLowerCase().includes(keyword.toLowerCase()));
  const configuredRoleJobTitles = organizationJobTitles.filter((item) => item.status === "启用").sort((a, b) => a.sort - b.sort);
  const candidateUsers = useDirectoryUserCandidates(roleMemberKeyword, editor !== null, editingMemberIds);
  const roleMemberCandidates = candidateUsers.filter((user) => !user.builtIn).map((user) => ({
    id: user.id,
    name: user.name,
    department: user.departmentPath,
    jobTitle: user.jobTitle,
  }));
  const visibleRoleMembers = roleMemberCandidates.filter((member) => {
    const matchesView = roleMemberView === "all" || editingMemberIds.includes(member.id);
    const normalizedKeyword = roleMemberKeyword.trim().toLowerCase();
    return matchesView && (!normalizedKeyword || `${member.name}${member.department}${member.jobTitle}`.toLowerCase().includes(normalizedKeyword));
  });
  const openEditor = (record: RoleRecord | "new") => {
    if (record !== "new" && record.builtIn) {
      message.info("超级管理员角色由系统内置，不能编辑");
      return;
    }
    setEditor(record);
    setEditorEtag(undefined);
    setEditorDirty(false);
    setEditingMemberIds(record === "new" ? [] : record.memberUserIds ?? identityUsers.filter((user) => record.members.includes(user.name)).map((user) => user.id));
    setRoleMemberKeyword("");
    setRoleMemberView("all");
    form.setFieldsValue(record === "new"
      ? { name: "", description: "", status: true, members: [] }
      : { ...record, status: record.status === "启用" });
    if (record !== "new") {
      void flowPilotApi.directory.roleResource(record.id).then((resource) => setEditorEtag(resource.etag)).catch(() => message.error("角色最新版本加载失败"));
    }
  };
  const columns: TableProps<RoleRecord>["columns"] = [
    { title: "角色", dataIndex: "name", width: 220, fixed: "left", render: (value: string, record) => <div className="gov-primary-cell"><strong>{value}{record.builtIn ? <Tag color="gold" icon={<LockOutlined />}>系统内置</Tag> : null}</strong></div> },
    { title: "说明", dataIndex: "description", width: 300, ellipsis: true },
    { title: "页面权限", dataIndex: "pagePermissions", width: 105, render: (value: number) => <strong>{value}</strong> },
    { title: "动作权限", dataIndex: "actionPermissions", width: 105, render: (value: number) => <strong>{value}</strong> },
    { title: "用户数", dataIndex: "users", width: 110, render: (value: number, record) => record.builtIn ? <Tag variant="filled">1 个内置账号</Tag> : <Button type="link" className="gov-count-link" onClick={() => { setMemberRole(record); setMemberKeyword(""); }}>{value} 人</Button> },
    { title: "状态", dataIndex: "status", width: 88, render: (status: EnableStatus) => <StatusTag status={status} /> },
    { title: "操作", fixed: "right", width: 184, align: "center", render: (_, record) => <Space size={4}>{canEditRoles && <Tooltip title={record.builtIn ? "系统内置角色不可编辑" : "编辑角色"}><Button disabled={record.builtIn} type="text" aria-label="编辑角色" icon={<EditOutlined />} onClick={() => openEditor(record)} /></Tooltip>}{canGrantRoles && <Tooltip title={record.builtIn ? "查看全部权限（只读）" : "配置权限"}><Button type="text" aria-label={record.builtIn ? "查看超级管理员权限" : "配置权限"} icon={record.builtIn ? <LockOutlined /> : <SafetyCertificateOutlined />} onClick={() => navigate(`/admin/permissions?roleId=${encodeURIComponent(record.id)}`)} /></Tooltip>}{canEditRoles && <Tooltip title={record.builtIn ? "系统内置角色不可停用" : record.status === "启用" ? "停用" : "启用"}><Button disabled={record.builtIn} type="text" aria-label={record.status === "启用" ? "停用角色" : "启用角色"} icon={record.status === "启用" ? <StopOutlined /> : <CheckCircleOutlined />} onClick={() => void changeRoleStatus(record)} /></Tooltip>}{canDeleteRoles && <Tooltip title={record.builtIn ? "系统内置角色不可删除" : "删除角色"}><Button danger disabled={record.builtIn} type="text" aria-label={`删除角色：${record.name}`} icon={<DeleteOutlined />} onClick={() => deleteRole(record)} /></Tooltip>}</Space> },
  ];
  return (
    <div className="page-stack gov-page">
      {roleEditorGuard}
      <Alert type="info" showIcon title="一个用户可以拥有多个角色" description="系统页面与动作权限取所有角色的并集。角色只决定系统功能权限，不等同于流程节点的办理资格。" />
      <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}>
        <div className="gov-toolbar"><Input allowClear prefix={<SearchOutlined />} placeholder="搜索角色名称或说明" value={keyword} onChange={(event) => setKeyword(event.target.value)} /><Space><Typography.Text type="secondary">共 {filtered.length} 个角色</Typography.Text>{canEditRoles && <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor("new")}>新增角色</Button>}</Space></div>
        <Table<RoleRecord> rowKey="id" columns={columns} dataSource={filtered} scroll={{ x: 940 }} pagination={{ pageSize: 10, showSizeChanger: false }} />
      </Card>
      <Drawer width={620} open={editor !== null} onClose={() => confirmEditorClose(editorDirty, "角色信息", () => { setEditorDirty(false); setEditor(null); })} title={editor === "new" ? "新增角色" : "编辑角色"} extra={<Space><Button onClick={() => confirmEditorClose(editorDirty, "角色信息", () => { setEditorDirty(false); setEditor(null); })}>取消</Button><Button type="primary" onClick={() => form.submit()}>保存</Button></Space>}>
        <Form form={form} layout="vertical" onValuesChange={() => setEditorDirty(true)} onFinish={async (values) => {
          const selectedNames = candidateUsers.filter((user) => editingMemberIds.includes(user.id)).map((user) => user.name);
          const patch = isBrowserMockMode
            ? { name: values.name.trim(), description: values.description, status: values.status ? "启用" as const : "停用" as const, members: selectedNames }
            : { name: values.name.trim(), description: values.description, status: values.status ? "启用" as const : "停用" as const, memberUserIds: editingMemberIds };
          try {
            if (editor === "new") cacheRole(await flowPilotApi.directory.createRole(patch));
            else if (editor) {
              if (!editorEtag) throw new Error("角色最新版本尚未加载完成");
              if (!await confirmRoleChange(editor.id, editingMemberIds, values.status ? "启用" : "停用")) return;
              cacheRole(await flowPilotApi.directory.updateRole(editor.id, patch, editorEtag));
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
              <Tag color="blue">已选择 {editingMemberIds.length} 人</Tag>
            </div>
            <div className="gov-role-member-picker__toolbar">
              <Input allowClear prefix={<SearchOutlined />} placeholder="搜索姓名、部门或职务" value={roleMemberKeyword} onChange={(event) => setRoleMemberKeyword(event.target.value)} />
              <Segmented
                value={roleMemberView}
                onChange={(value) => setRoleMemberView(value as "all" | "selected")}
                options={[
                  { label: `全部成员 ${roleMemberCandidates.length}`, value: "all" },
                  { label: `已选择 ${editingMemberIds.length}`, value: "selected" },
                ]}
              />
            </div>
            <div className="gov-role-member-picker__bulk">
              <Typography.Text type="secondary">当前显示 {visibleRoleMembers.length} 人</Typography.Text>
              <Space size={4}>
                <Button type="link" size="small" disabled={visibleRoleMembers.length === 0} onClick={() => { setEditorDirty(true); setEditingMemberIds((current) => Array.from(new Set([...current, ...visibleRoleMembers.map((member) => member.id)]))); }}>选择当前结果</Button>
                <Button type="link" size="small" disabled={editingMemberIds.length === 0} onClick={() => { setEditorDirty(true); setEditingMemberIds([]); }}>清空已选</Button>
              </Space>
            </div>
            <div className="gov-role-member-picker__list">
              {visibleRoleMembers.map((member) => (
                <label className={editingMemberIds.includes(member.id) ? "gov-role-member-option is-selected" : "gov-role-member-option"} key={member.id}>
                  <Checkbox
                    checked={editingMemberIds.includes(member.id)}
                    onChange={(event) => { setEditorDirty(true); setEditingMemberIds((current) => event.target.checked ? [...new Set([...current, member.id])] : current.filter((id) => id !== member.id)); }}
                  />
                  <PersonChip name={member.name} detail={member.department} />
                  <Tag variant="filled">{member.jobTitle}</Tag>
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

const permissionRows = permissionCatalogPages;

type RolePermissionMap = Record<string, string[]>;

function readRolePermissionMap(): RolePermissionMap {
  return readStoredRolePermissions();
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
  const [catalogRows, setCatalogRows] = useState(permissionRows);
  const availableRoles = useMemo(
    () => applyRolePermissionStats(identityRoles, permissionsByRole),
    [identityRoles, permissionsByRole],
  );
  const requestedRoleId = searchParams.get("roleId");
  const initialRoleId = availableRoles.some((role) => role.id === requestedRoleId) ? requestedRoleId! : availableRoles[0]?.id ?? "";
  const [roleId, setRoleId] = useState(initialRoleId);
  const [granted, setGranted] = useState(() => new Set(permissionsByRole[initialRoleId] ?? []));
  const [pendingRoleId, setPendingRoleId] = useState<string | null>(null);
  const currentRole = availableRoles.find((role) => role.id === roleId) ?? availableRoles[0];
  const isBuiltInRole = Boolean(currentRole?.builtIn);
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
    const nextRoleId = availableRoles.some((role) => role.id === roleId)
      ? roleId
      : availableRoles.some((role) => role.id === requestedRoleId)
        ? requestedRoleId!
        : availableRoles[0]?.id ?? "";
    if (nextRoleId === roleId) return;
    setRoleId(nextRoleId);
    setGranted(new Set(permissionsByRole[nextRoleId] ?? []));
    if (nextRoleId) setSearchParams({ roleId: nextRoleId }, { replace: true });
  }, [availableRoles, permissionsByRole, requestedRoleId, roleId, setSearchParams]);
  useEffect(() => {
    let cancelled = false;
    void flowPilotApi.organization.permissionCatalog().then((items) => {
      if (cancelled) return;
      const knownKeys = new Set(permissionRows.map((row) => row.key));
      const merged = permissionRows.map((row) => ({
        ...row,
        actions: items.filter((item) => item.page === row.key).map((item) => item.action),
      })).map((row) => ({ ...row, actions: row.actions.length ? row.actions : permissionRows.find((item) => item.key === row.key)!.actions }));
      const unknown = [...new Set(items.filter((item) => !knownKeys.has(item.page)).map((item) => item.page))].map((key) => ({
        key,
        module: "其他权限",
        page: items.find((item) => item.page === key)?.category || key,
        description: items.find((item) => item.page === key)?.description || "由服务端权限目录提供",
        actions: items.filter((item) => item.page === key).map((item) => item.action),
      }));
      setCatalogRows([...merged, ...unknown]);
    }).catch(() => {
      if (!cancelled) message.error("权限目录加载失败，已保留内置目录，请刷新后重试");
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!roleId) return;
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
      const pageHasViewPermission = catalogRows.find((row) => row.key === pageKey)?.actions.includes("查看") ?? false;
      if (action !== "查看" && pageHasViewPermission) next.add(`${pageKey}:查看`);
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
    if (import.meta.env.VITE_API_MODE === "remote") {
      await flowPilotApi.auth.me();
    }
    notifyRolePermissionsChanged();
    return nextPermissionMap;
  };
  const savePermissions = async () => {
    try {
      await persistPermissions();
      message.success(`${currentRole?.name ?? "当前角色"} 的权限已保存`);
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
        title={isBuiltInRole ? "超级管理员权限为系统内置，只读展示" : "角色权限统一在本页配置"}
        description={isBuiltInRole ? "该角色始终拥有全部页面和动作权限，并可越过流程权限组执行所有流程的发起与审核；它不会出现在流程人员名单或候选人选择器中。" : "日常新增、修改和启用/停用统一由“编辑”权限控制；发布、授权、重置密码、导出等敏感动作仍单独授权。某个流程节点由谁处理，仍由“流程权限组”配置。"}
      />
      <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}>
        <div className="gov-permission-toolbar"><div><Select aria-label="选择要配置的角色" showSearch optionFilterProp="label" placeholder="暂无角色" value={roleId || undefined} onChange={selectRole} options={availableRoles.map((role) => ({ value: role.id, label: `${role.name}${role.builtIn ? " · 系统内置" : role.status === "停用" ? " · 已停用" : ""}` }))} /></div><Space><Tag color={isBuiltInRole ? "gold" : isDirty ? "gold" : "green"}>{isBuiltInRole ? "全部权限 · 不可修改" : isDirty ? "有未保存修改" : "已保存"}</Tag><Button disabled={!roleId || isBuiltInRole || !isDirty} onClick={() => { setGranted(new Set(permissionsByRole[roleId] ?? [])); message.info("已恢复当前角色上次保存的权限"); }}>恢复</Button><Button disabled={!roleId || isBuiltInRole || !isDirty} type="primary" icon={isBuiltInRole ? <LockOutlined /> : <SafetyCertificateOutlined />} onClick={savePermissions}>保存权限</Button></Space></div>
        <div className="gov-permission-summary"><div><strong>{permissionStats.pagePermissions}</strong><span>已授权页面</span></div><Progress percent={Math.round(granted.size / catalogRows.reduce((sum, row) => sum + row.actions.length, 0) * 100)} showInfo={false} /><Typography.Text type="secondary">已选择 {permissionStats.actionPermissions} 个动作；保存后角色列表统计同步更新，不会改变流程待办。</Typography.Text></div>
        <div className="gov-permission-matrix">
          <div className="gov-permission-row gov-permission-head"><span>模块 / 页面</span><span>页面说明</span><span>动作权限</span></div>
          {catalogRows.map((row, index) => <div className="gov-permission-row" key={row.key}><div className="gov-permission-page">{index === 0 || catalogRows[index - 1]?.module !== row.module ? <small>{row.module}</small> : <small className="is-continuation">↳</small>}<strong>{row.page}</strong></div><Typography.Text type="secondary">{row.description}</Typography.Text><div className="gov-permission-actions">{row.actions.map((action) => <Checkbox disabled={isBuiltInRole} key={action} checked={granted.has(`${row.key}:${action}`)} onChange={(event) => toggle(`${row.key}:${action}`, event.target.checked)}>{action}</Checkbox>)}</div></div>)}
        </div>
      </Card>
      <Modal
        open={Boolean(pendingRoleId)}
        title="当前角色权限尚未保存"
        onCancel={() => setPendingRoleId(null)}
        closable={false}
        mask={{ closable: false }}
        footer={[
          <Button key="cancel" onClick={() => setPendingRoleId(null)}>取消</Button>,
          <Button key="discard" danger onClick={() => { if (pendingRoleId) switchRole(pendingRoleId); setPendingRoleId(null); }}>放弃修改并切换</Button>,
          <Button key="save" type="primary" onClick={() => { void persistPermissions().then((nextMap) => { if (pendingRoleId) switchRole(pendingRoleId, nextMap); setPendingRoleId(null); }).catch(() => message.error("权限保存失败，请刷新后重试")); }}>保存并切换</Button>,
        ]}
      >
        <Typography.Paragraph>你修改了“{currentRole?.name ?? "当前角色"}”的权限。切换角色前请选择如何处理这些修改。</Typography.Paragraph>
      </Modal>
      <Modal
        open={blocker.state === "blocked"}
        title="离开前保存权限修改？"
        onCancel={() => blocker.state === "blocked" && blocker.reset()}
        closable={false}
        mask={{ closable: false }}
        footer={[
          <Button key="stay" onClick={() => blocker.state === "blocked" && blocker.reset()}>留在当前页</Button>,
          <Button key="discard" danger onClick={() => blocker.state === "blocked" && blocker.proceed()}>放弃修改并离开</Button>,
          <Button key="save" type="primary" onClick={() => { void persistPermissions().then(() => { if (blocker.state === "blocked") blocker.proceed(); }).catch(() => message.error("权限保存失败，请刷新后重试")); }}>保存并离开</Button>,
        ]}
      >
        <Typography.Paragraph>“{currentRole?.name ?? "当前角色"}”存在未保存的权限修改。直接离开会丢失这些修改。</Typography.Paragraph>
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
    () => isBrowserMockMode ? deriveAllWorkflowGroupStatistics(storedGroups, definitions, tasks) : storedGroups,
    [definitions, storedGroups, tasks],
  );
  const identityUsers = useIdentityStore((state) => state.users);
  const identityRoles = useIdentityStore((state) => state.roles);
  const personaId = usePrototypeStore((state) => state.personaId);
  const canEditGroups = hasPersonaPermission(personaId, "org-group:编辑");
  const canDeleteGroups = hasPersonaPermission(personaId, "org-group:删除");
  const [keyword, setKeyword] = useState("");
  const [process, setProcess] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [editor, setEditor] = useState<GroupRecord | "new" | null>(null);
  const [preview, setPreview] = useState<GroupRecord | null>(null);
  const [remotePreviewMembers, setRemotePreviewMembers] = useState<EffectiveWorkflowMember[]>([]);
  const [remotePreviewLoading, setRemotePreviewLoading] = useState(false);
  const [remotePreviewPage, setRemotePreviewPage] = useState(1);
  const [remotePreviewTotal, setRemotePreviewTotal] = useState(0);
  const [directMemberUserIds, setDirectMemberUserIds] = useState<string[]>([]);
  const [linkedRoleIds, setLinkedRoleIds] = useState<string[]>([]);
  const [effectiveMemberKeyword, setEffectiveMemberKeyword] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorEtag, setEditorEtag] = useState<string>();
  const candidateUsers = useDirectoryUserCandidates(effectiveMemberKeyword, editor !== null, directMemberUserIds);
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
  const deleteGroup = (record: GroupRecord) => {
    Modal.confirm({
      title: `删除流程权限组 ${record.name}？`,
      content: "删除前会检查全部流程版本和节点配置引用。已被引用的权限组不能删除，只能停用。",
      okText: "检查并删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          const resource = await flowPilotApi.directory.groupResource(record.id);
          await flowPilotApi.directory.deleteGroup(record.id, resource.etag ?? "*");
          setGroups((rows) => rows.filter((group) => group.id !== record.id));
          message.success(`流程权限组 ${record.name} 已删除`);
        } catch (error) {
          message.error(error instanceof Error ? error.message : "流程权限组删除失败，请刷新后重试");
        }
      },
    });
  };
  const filtered = groups.filter((group) => `${group.name}${group.id}`.toLowerCase().includes(keyword.toLowerCase()) && (!process || group.processes.includes(process)) && (!status || group.status === status));
  const directMembers = candidateUsers.filter((user) => directMemberUserIds.includes(user.id)).map((user) => user.name);
  const linkedRoles = identityRoles.filter((role) => linkedRoleIds.includes(role.id)).map((role) => role.name);
  const derived = effectiveMembers({ directMembers, linkedRoles, directMemberUserIds, linkedRoleIds });
  const visibleDerived = derived.filter((name) => name.toLowerCase().includes(effectiveMemberKeyword.trim().toLowerCase()));
  const loadRemoteMemberPreview = (record: GroupRecord, page: number) => {
    setRemotePreviewLoading(true);
    void flowPilotApi.organization.groupEffectiveMembers(record.id, { page, pageSize: 50 })
      .then((result) => {
        setRemotePreviewMembers(result.items);
        setRemotePreviewTotal(result.page.totalElements);
      })
      .catch(() => message.error("有效成员加载失败，请刷新后重试"))
      .finally(() => setRemotePreviewLoading(false));
  };
  const openMemberPreview = (record: GroupRecord) => {
    setPreview(record);
    setRemotePreviewMembers([]);
    setRemotePreviewPage(1);
    setRemotePreviewTotal(record.effectiveMemberCount ?? 0);
    if (!isBrowserMockMode) loadRemoteMemberPreview(record, 1);
  };
  const openEditor = (record: GroupRecord | "new") => {
    setEditor(record);
    setEditorEtag(undefined);
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
    if (record !== "new") {
      void flowPilotApi.directory.groupResource(record.id).then((resource) => setEditorEtag(resource.etag)).catch(() => message.error("流程权限组最新版本加载失败"));
    }
  };
  const columns: TableProps<GroupRecord>["columns"] = [
    { title: "流程权限组", dataIndex: "name", width: 260, fixed: "left", render: (value: string, record) => <div className="gov-primary-cell"><strong>{value}</strong><small>{record.code}</small></div> },
    { title: "已引用流程", dataIndex: "processes", width: 240, render: (values: string[]) => values.length ? <Space size={[4, 4]} wrap>{values.map((value) => <Tag key={value} variant="filled">{value}</Tag>)}</Space> : <Typography.Text type="secondary">暂未关联流程</Typography.Text> },
    { title: "允许用途", dataIndex: "purposes", width: 220, render: (values: GroupPurpose[]) => <Space size={[4, 4]} wrap>{values.map((value) => <Tag key={value} color={value === "发起" ? "cyan" : value === "审批/受理" ? "blue" : "volcano"}>{value}</Tag>)}</Space> },
    { title: "成员构成", key: "composition", width: 220, render: (_, record) => <div className="gov-composition"><span><UserOutlined /> 直接 {record.directMemberUserIds?.length ?? record.directMembers.length}</span><span><TeamOutlined /> 角色 {record.linkedRoleIds?.length ?? record.linkedRoles.length}</span></div> },
    { title: "有效成员", key: "effective", width: 112, render: (_, record) => <Button className="gov-count-link" type="link" onClick={() => openMemberPreview(record)}>{isBrowserMockMode ? effectiveMembers(record).length : record.effectiveMemberCount ?? 0} 人</Button> },
    { title: "状态", dataIndex: "status", width: 118, align: "center", render: (value: EnableStatus) => <StatusTag status={value} /> },
    { title: "更新时间", dataIndex: "updatedAt", width: 150, render: (value: string) => formatDisplayDateTime(value) },
    { title: "操作", fixed: "right", width: 180, align: "center", render: (_, record) => <Space size={4}>{canEditGroups && <Tooltip title="编辑"><Button type="text" aria-label={`编辑权限组：${record.name}`} icon={<EditOutlined />} onClick={() => openEditor(record)} /></Tooltip>}<Tooltip title="有效成员预览"><Button type="text" aria-label={`预览有效成员：${record.name}`} icon={<EyeOutlined />} onClick={() => openMemberPreview(record)} /></Tooltip>{canEditGroups && <Tooltip title={record.status === "启用" ? "停用" : "启用"}><Popconfirm title={record.status === "启用" && record.openTasks ? `停用不影响已有 ${record.openTasks} 项待办，确认继续？` : "确认修改状态？"} onConfirm={() => void changeGroupStatus(record)}><Button type="text" aria-label={`${record.status === "启用" ? "停用" : "启用"}权限组：${record.name}`} icon={record.status === "启用" ? <StopOutlined /> : <CheckCircleOutlined />} /></Popconfirm></Tooltip>}{canDeleteGroups && <Tooltip title={record.referenced || record.processes.length ? "已被流程版本引用，不能删除" : "删除流程权限组"}><Button danger disabled={Boolean(record.referenced || record.processes.length)} type="text" aria-label={`删除权限组：${record.name}`} icon={<DeleteOutlined />} onClick={() => deleteGroup(record)} /></Tooltip>}</Space> },
  ];
  return (
    <div className="page-stack gov-page">
      {workflowGroupEditorGuard}
      <Alert type="info" showIcon title="成员变化立即影响运行中的待办" description="直接成员和关联角色成员合并去重后形成有效成员。允许用途决定权限组可出现的设计位置，已引用流程由系统自动统计；停用权限组不影响已运行流程，引用后不可删除。" />
      <Card className="query-card gov-query-card"><div className="gov-filter-grid gov-filter-grid--groups"><label><span>关键词</span><Input allowClear prefix={<SearchOutlined />} placeholder="权限组名称或编号" value={keyword} onChange={(event) => setKeyword(event.target.value)} /></label><label><span>已引用流程</span><Select allowClear placeholder="全部流程" value={process} onChange={setProcess} options={[...new Set(groups.flatMap((group) => group.processes))].map((value) => ({ value }))} /></label><label><span>状态</span><Select allowClear placeholder="全部状态" value={status} onChange={setStatus} options={["启用", "停用"].map((value) => ({ value }))} /></label><div className="gov-filter-actions"><Button icon={<ReloadOutlined />} onClick={() => { setKeyword(""); setProcess(undefined); setStatus(undefined); }}>重置</Button></div></div></Card>
      <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}><ResultHeader title="流程权限组" count={filtered.length} extra={canEditGroups ? <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor("new")}>新增权限组</Button> : null} /><Table<GroupRecord> rowKey="id" columns={columns} dataSource={filtered} scroll={{ x: 1400 }} pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 个权限组` }} /></Card>
      <Drawer width={720} open={editor !== null} onClose={() => confirmEditorClose(editorDirty, "流程权限组", () => { setEditorDirty(false); setEditor(null); })} title={editor === "new" ? "新增流程权限组" : "编辑流程权限组"} extra={<Space><Button onClick={() => confirmEditorClose(editorDirty, "流程权限组", () => { setEditorDirty(false); setEditor(null); })}>取消</Button><Button type="primary" onClick={() => form.submit()}>保存并立即生效</Button></Space>}>
        {editor !== "new" && editor?.openTasks ? <Alert className="gov-drawer-alert" type="warning" showIcon title={`当前有 ${editor.openTasks} 项运行待办`} description="保存后，新增成员立即获得处理资格；被移除成员将立即失去尚未处理的待办资格。" /> : null}
        <Form form={form} layout="vertical" onValuesChange={() => setEditorDirty(true)} onFinish={async (values) => {
          try {
            if (editor === "new") {
              cacheGroup(await flowPilotApi.directory.createGroup(isBrowserMockMode
                ? { name: values.name, purposes: values.purposes, directMembers, linkedRoles, status: values.status ? "启用" : "停用" }
                : { name: values.name, purposes: values.purposes, directMembers: [], linkedRoles: [], directMemberUserIds, linkedRoleIds, status: values.status ? "启用" : "停用" }));
            } else if (editor) {
              if (!editorEtag) throw new Error("流程权限组最新版本尚未加载完成");
              cacheGroup(await flowPilotApi.directory.updateGroup(editor.id, isBrowserMockMode
                ? { name: values.name, purposes: values.purposes, directMembers, linkedRoles, status: values.status ? "启用" : "停用" }
                : { name: values.name, purposes: values.purposes, directMembers: [], linkedRoles: [], directMemberUserIds, linkedRoleIds, status: values.status ? "启用" : "停用" }, editorEtag));
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
          <div className="gov-group-editor-section"><div className="gov-section-title"><span><UserOutlined />直接成员</span><Tag>{directMemberUserIds.length} 人</Tag></div><Typography.Paragraph type="secondary">逐个加入的固定人员，不依赖其系统角色。正式模式按输入内容从服务端搜索。</Typography.Paragraph><Form.Item name="directMemberUserIds"><Select mode="multiple" showSearch filterOption={isBrowserMockMode} optionFilterProp="label" maxTagCount="responsive" onSearch={setEffectiveMemberKeyword} options={candidateUsers.filter((user) => !user.builtIn && user.status === "启用").map((user) => ({ value: user.id, label: `${user.name} · ${user.departmentPath}` }))} onChange={(values) => { setEditorDirty(true); setDirectMemberUserIds(values); }} /></Form.Item></div>
          <div className="gov-group-editor-section"><div className="gov-section-title"><span><TeamOutlined />关联角色</span><Tag>{linkedRoleIds.length} 个</Tag></div><Typography.Paragraph type="secondary">角色下的全部用户动态加入；角色成员变化会立即同步到本权限组。</Typography.Paragraph><Form.Item name="linkedRoleIds"><Select mode="multiple" showSearch optionFilterProp="label" options={identityRoles.filter((role) => !role.builtIn && role.status === "启用").map((role) => ({ value: role.id, label: role.name }))} onChange={(values) => { setEditorDirty(true); setLinkedRoleIds(values); }} /></Form.Item></div>
          {isBrowserMockMode ? <div className="gov-effective-preview">
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
                    <div><strong>{name}</strong><Tag color="success" variant="filled">有效</Tag></div>
                    <small>{[direct ? "直接加入" : "", roles.length ? `角色带入：${roles.join("、")}` : ""].filter(Boolean).join(" · ")}</small>
                  </div>
                );
              })}
              {visibleDerived.length === 0 && <div className="gov-effective-member-empty">没有符合条件的有效成员</div>}
            </div>
            <Typography.Text type="secondary">完整姓名与成员来源直接显示；成员较多时可搜索并在列表内滚动查看。</Typography.Text>
          </div> : <Alert type="info" showIcon title="完整有效成员将在保存后由服务端计算" description="编辑时只提交直接成员和关联角色；保存后可从列表的有效成员数量进入服务端分页结果，避免用当前页用户缓存产生错误统计。" />}
        </Form>
      </Drawer>
      <Drawer width={560} open={Boolean(preview)} onClose={() => setPreview(null)} title={`${preview?.name ?? ""} · 有效成员`}>
        <Alert className="gov-drawer-alert" type="info" showIcon title="相同人员仅计一次" description="来源标签用于说明人员是被直接添加、通过角色加入，或同时来自两种方式。" />
        <div className="gov-member-list">{preview && isBrowserMockMode ? effectiveMembers(preview).map((name) => { const user = identityUsers.find((item) => item.name === name); const direct = user ? preview.directMemberUserIds?.includes(user.id) ?? false : false; const roles = identityRoles.filter((role) => preview.linkedRoleIds?.includes(role.id) && user?.roleIds?.includes(role.id)).map((role) => role.name); return <div className="gov-member-row" key={name}><PersonChip name={name} detail={user?.departmentPath} /><Space size={[4, 4]} wrap>{direct ? <Tag color="cyan">直接加入</Tag> : null}{roles.map((role) => <Tag color="purple" key={role}>角色带入：{role}</Tag>)}</Space></div>; }) : remotePreviewMembers.map((member) => <div className="gov-member-row" key={member.id}><PersonChip name={member.name} detail={member.departmentPath || member.account} /><Space size={[4, 4]} wrap>{member.sources.map((source) => <Tag color={source === "direct" ? "cyan" : "purple"} key={source}>{source === "direct" ? "直接加入" : `角色带入：${source.slice(5)}`}</Tag>)}</Space></div>)}</div>
        {remotePreviewLoading ? <Typography.Text type="secondary">正在加载有效成员…</Typography.Text> : null}
        {!isBrowserMockMode && remotePreviewTotal > 50 ? <Pagination current={remotePreviewPage} pageSize={50} total={remotePreviewTotal} showSizeChanger={false} showTotal={(total) => `共 ${total} 人`} onChange={(nextPage) => { if (!preview) return; setRemotePreviewPage(nextPage); loadRemoteMemberPreview(preview, nextPage); }} /> : null}
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
  const [remoteInstances, setRemoteInstances] = useState<typeof instances>([]);
  const [remoteTotal, setRemoteTotal] = useState(0);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [monitorPage, setMonitorPage] = useState(1);
  const [monitorPageSize, setMonitorPageSize] = useState(10);
  const [keyword, setKeyword] = useState("");
  const [process, setProcess] = useState<string>();
  const [status, setStatus] = useState<InstanceMonitorStatus>();
  const [dateRange, setDateRange] = useState(createDefaultDateRange);
  const [appliedFilters, setAppliedFilters] = useState(() => ({ keyword: "", process: undefined as string | undefined, status: undefined as InstanceMonitorStatus | undefined, dateRange: createDefaultDateRange() }));
  const [detail, setDetail] = useState<MonitorRecord | null>(null);
  useEffect(() => {
    if (isBrowserMockMode) return;
    let cancelled = false;
    setRemoteLoading(true);
    const normalizedRange = normalizeDayRange(appliedFilters.dateRange);
    void flowPilotApi.instances.list({
      page: monitorPage,
      pageSize: monitorPageSize,
      q: appliedFilters.keyword.trim() || undefined,
      definitionId: appliedFilters.process,
      status: appliedFilters.status,
      createdFrom: normalizedRange[0].format("YYYY-MM-DD"),
      createdTo: normalizedRange[1].format("YYYY-MM-DD"),
    }).then((response) => {
      if (!cancelled) {
        setRemoteInstances(response.items);
        setRemoteTotal(response.page.totalElements);
      }
    }).catch(() => {
      if (!cancelled) message.error("流程实例加载失败，请稍后重试");
    }).finally(() => {
      if (!cancelled) setRemoteLoading(false);
    });
    return () => { cancelled = true; };
  }, [appliedFilters, monitorPage, monitorPageSize]);
  const sourceInstances = isBrowserMockMode ? instances : remoteInstances;
  const monitorRows = useMemo(() => sourceInstances.map((instance): MonitorRecord => {
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
  }), [definitions, sourceInstances]);
  const filtered = isBrowserMockMode
    ? monitorRows.filter((row) => `${row.code}${row.title}${row.initiator}`.toLowerCase().includes(appliedFilters.keyword.toLowerCase()) && (!appliedFilters.process || definitions.find((item) => item.id === appliedFilters.process)?.name === row.process) && (!appliedFilters.status || row.status === appliedFilters.status) && isDateTimeInRange(row.createdAt, appliedFilters.dateRange))
    : monitorRows;
  const columns: TableProps<MonitorRecord>["columns"] = [
    { title: "实例编号", dataIndex: "code", width: 170, fixed: "left", render: (value: string, record) => <Button className="gov-table-link" type="link" onClick={() => setDetail(record)}>{value}</Button> },
    { title: "标题", dataIndex: "title", width: 280, ellipsis: true },
    { title: "流程 / 版本", dataIndex: "process", width: 155, render: (value: string, record) => <div className="gov-primary-cell"><strong>{value}</strong><small>{record.version}</small></div> },
    { title: "状态", dataIndex: "status", width: 118, render: (value: InstanceMonitorStatus) => <StatusPill status={value} /> },
    { title: "当前节点", dataIndex: "node", width: 210, ellipsis: true, render: (value: string) => value || "—" },
    { title: "发起人", dataIndex: "initiator", width: 125, render: (value: string, record) => <div className="gov-primary-cell"><strong>{value}</strong><small>{record.department}</small></div> },
    { title: "发起时间", dataIndex: "createdAt", width: 155, render: (value: string) => formatDisplayDateTime(value) },
    { title: "更新时间", dataIndex: "updatedAt", width: 155, render: (value: string) => formatDisplayDateTime(value) },
    { title: "操作", fixed: "right", width: 80, align: "center", render: (_, record) => <Tooltip title="查看详情"><Button type="text" aria-label={`查看流程实例：${record.title}`} icon={<EyeOutlined />} onClick={() => setDetail(record)} /></Tooltip> },
  ];
  return (
    <div className="page-stack gov-page">
      <Alert type="info" showIcon title="实例监控为只读页面" description="运维人员可以查询和查看流程、表单及流转信息，但不能强制关闭、改派、跳过节点或修改业务数据。" />
      <Card className="query-card gov-query-card"><div className="gov-filter-grid gov-filter-grid--monitor"><label><span>关键词</span><Input allowClear prefix={<SearchOutlined />} placeholder="实例编号、标题或发起人" value={keyword} onChange={(event) => setKeyword(event.target.value)} onPressEnter={() => { setMonitorPage(1); setAppliedFilters({ keyword, process, status, dateRange }); }} /></label><label><span>流程</span><Select allowClear placeholder="全部流程" value={process} onChange={setProcess} options={definitions.map((definition) => ({ value: definition.id, label: definition.name }))} /></label><label><span>状态</span><Select allowClear placeholder="全部状态" value={status} onChange={setStatus} options={monitorStatuses.map((value) => ({ value }))} /></label><label><span>发起时间</span><DatePicker.RangePicker allowClear={false} value={dateRange} onChange={(value) => { if (value?.[0] && value[1]) setDateRange(normalizeDayRange([value[0], value[1]])); }} /></label><div className="gov-filter-actions"><Button type="primary" icon={<SearchOutlined />} onClick={() => { setMonitorPage(1); setAppliedFilters({ keyword, process, status, dateRange }); }}>查询</Button><Button icon={<ReloadOutlined />} onClick={() => { const nextRange = createDefaultDateRange(); setKeyword(""); setProcess(undefined); setStatus(undefined); setDateRange(nextRange); setMonitorPage(1); setAppliedFilters({ keyword: "", process: undefined, status: undefined, dateRange: nextRange }); }}>重置</Button></div></div></Card>
      <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}><ResultHeader title="流程实例" count={isBrowserMockMode ? filtered.length : remoteTotal} extra={<Typography.Text type="secondary"><LockOutlined /> 全部操作只读</Typography.Text>} /><Table<MonitorRecord> loading={remoteLoading} rowKey="id" columns={columns} dataSource={filtered} scroll={{ x: 1510 }} pagination={{ current: monitorPage, pageSize: monitorPageSize, total: isBrowserMockMode ? filtered.length : remoteTotal, showSizeChanger: true, showTotal: (total) => `共 ${total} 条实例`, onChange: (nextPage, nextPageSize) => { setMonitorPage(nextPageSize === monitorPageSize ? nextPage : 1); setMonitorPageSize(nextPageSize); } }} /></Card>
      <Drawer width={660} open={Boolean(detail)} onClose={() => setDetail(null)} title="流程实例详情（只读）">
        {detail ? <><div className="gov-detail-hero-row"><span className="gov-detail-icon"><FileSearchOutlined /></span><div><Typography.Title level={4}>{detail.title}</Typography.Title><Typography.Text type="secondary">{detail.code} · {detail.process} {detail.version}</Typography.Text></div><StatusPill status={detail.status} /></div><Descriptions bordered column={2} size="small" items={[{ key: "initiator", label: "发起人", children: `${detail.initiator}（${detail.department}）` }, { key: "created", label: "发起时间", children: formatDisplayDateTime(detail.createdAt) }, { key: "node", label: "当前节点", children: detail.node || "—" }, { key: "updated", label: "更新时间", children: formatDisplayDateTime(detail.updatedAt) }]} /><div className="gov-detail-section"><div className="gov-section-title">流转概览</div><Timeline items={[{ color: "green", content: <><strong>{detail.initiator} 发起流程</strong><small>{formatDisplayDateTime(detail.createdAt)}</small></> }, { color: "blue", content: <><strong>进入 {detail.node || "结束"}</strong><small>{formatDisplayDateTime(detail.updatedAt)}</small></> }, { color: "gray", content: <Typography.Text type="secondary">后续流转记录将在这里按时间显示</Typography.Text> }]} /></div><Alert type="warning" showIcon title="只读限制" description="本页没有关闭、变更受理人、跳过节点或修改表单的入口。" /></> : null}
      </Drawer>
    </div>
  );
}

type AuditResult = "成功" | "失败";
interface AuditRecord { id: string; operator: string; department: string; module: string; summary: string; action: string; result: AuditResult; time: string; detail: string; }

export function AuditLogPage() {
  const instances = usePrototypeStore((state) => state.instances);
  const tasks = usePrototypeStore((state) => state.tasks);
  const debugMode = isBrowserMockMode;
  const [remoteAuditEvents, setRemoteAuditEvents] = useState<AuditEvent[]>([]);
  const [remoteAuditTotal, setRemoteAuditTotal] = useState(0);
  const [remoteAuditLoading, setRemoteAuditLoading] = useState(false);
  const [auditPage, setAuditPage] = useState(1);
  const [auditPageSize, setAuditPageSize] = useState(10);
  const [keyword, setKeyword] = useState("");
  const [module, setModule] = useState<string>();
  const [result, setResult] = useState<AuditResult>();
  const [dateRange, setDateRange] = useState(createDefaultDateRange);
  const [appliedFilters, setAppliedFilters] = useState(() => ({ keyword: "", module: undefined as string | undefined, result: undefined as AuditResult | undefined, dateRange: createDefaultDateRange() }));
  const [detail, setDetail] = useState<AuditRecord | null>(null);
  useEffect(() => {
    if (debugMode) return;
    let cancelled = false;
    setRemoteAuditLoading(true);
    const normalizedRange = normalizeDayRange(appliedFilters.dateRange);
    const categoryByModule: Record<string, AuditEvent["category"]> = {
      登录认证: "authentication",
      流程配置: "definition",
      流程实例: "instance",
      审批任务: "task",
      用户与权限: "identity",
    };
    void flowPilotApi.audit.events({
      page: auditPage,
      pageSize: auditPageSize,
      q: appliedFilters.keyword.trim() || undefined,
      category: appliedFilters.module ? categoryByModule[appliedFilters.module] : undefined,
      result: appliedFilters.result === "成功" ? "success" : appliedFilters.result === "失败" ? "failure" : undefined,
      dateFrom: normalizedRange[0].toISOString(),
      dateTo: normalizedRange[1].toISOString(),
    }).then((response) => {
      if (!cancelled) {
        setRemoteAuditEvents(response.items);
        setRemoteAuditTotal(response.page.totalElements);
      }
    }).catch(() => {
      if (!cancelled) {
        setRemoteAuditEvents([]);
        message.error("审计日志加载失败，请稍后重试");
      }
    }).finally(() => {
      if (!cancelled) setRemoteAuditLoading(false);
    });
    return () => { cancelled = true; };
  }, [appliedFilters, auditPage, auditPageSize, debugMode]);
  const auditRows = useMemo(() => {
    const eventsById = new Map(
      (debugMode
        ? [...readLocalAuditEvents(), ...collectRuntimeAuditEvents(instances, tasks)]
        : remoteAuditEvents).map((event) => [event.id, event]),
    );
    return Array.from(eventsById.values()).map((event): AuditRecord => {
      const actor = event.actorId ? findIdentityUser(event.actorId) : undefined;
      return {
        id: event.id,
        operator: event.operatorName && event.operatorName !== event.actorName
          ? `${event.operatorName} → ${event.actorName ?? actor?.name ?? "未知用户"}`
          : event.actorName ?? actor?.name ?? "系统",
        department: event.operatorDepartmentPath ?? event.actorDepartmentPath ?? actor?.departmentPath ?? "系统",
        module: auditModuleLabel(event.category),
        summary: auditSummaryText(event),
        action: auditActionLabel(event),
        result: auditResultLabel(event),
        time: event.occurredAt,
        detail: auditDetailText(event),
      };
    }).sort((left, right) => compareDomainTimestamps(right.time, left.time));
  }, [debugMode, instances, remoteAuditEvents, tasks]);
  const filtered = debugMode
    ? auditRows.filter((row) => `${row.operator}${row.summary}${row.action}${row.module}`.toLowerCase().includes(appliedFilters.keyword.toLowerCase()) && (!appliedFilters.module || row.module === appliedFilters.module) && (!appliedFilters.result || row.result === appliedFilters.result) && isDateTimeInRange(row.time, appliedFilters.dateRange))
    : auditRows;
  const columns: TableProps<AuditRecord>["columns"] = [
    { title: "时间", dataIndex: "time", width: 170, fixed: "left", render: (value: string) => formatDisplayDateTime(value) },
    { title: "操作人", dataIndex: "operator", width: 145, render: (value: string, record) => <div className="gov-primary-cell"><strong>{value}</strong><small>{record.department}</small></div> },
    { title: "模块", dataIndex: "module", width: 120, render: (value: string) => <Tag>{value}</Tag> },
    { title: "操作内容", dataIndex: "summary", width: 360, ellipsis: true, render: (value: string) => <Typography.Text>{value}</Typography.Text> },
    { title: "动作", dataIndex: "action", width: 120 },
    { title: "结果", dataIndex: "result", width: 88, render: (value: AuditResult) => <StatusPill status={value} /> },
    { title: "查看", fixed: "right", width: 78, align: "center", render: (_, record) => <Tooltip title="查看详情"><Button type="text" aria-label={`查看审计详情：${record.summary}`} icon={<EyeOutlined />} onClick={() => setDetail(record)} /></Tooltip> },
  ];
  return (
    <div className="page-stack gov-page">
      <Card className="query-card gov-query-card"><div className="gov-filter-grid gov-filter-grid--audit"><label><span>关键词</span><Input allowClear prefix={<SearchOutlined />} placeholder="操作人或操作内容" value={keyword} onChange={(event) => setKeyword(event.target.value)} onPressEnter={() => { setAuditPage(1); setAppliedFilters({ keyword, module, result, dateRange }); }} /></label><label><span>模块</span><Select allowClear placeholder="全部模块" value={module} onChange={setModule} options={["登录认证", "流程配置", "流程实例", "审批任务", "用户与权限"].map((value) => ({ value }))} /></label><label><span>结果</span><Select allowClear placeholder="全部结果" value={result} onChange={setResult} options={["成功", "失败"].map((value) => ({ value }))} /></label><label><span>操作时间</span><DatePicker.RangePicker allowClear={false} showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" value={dateRange} onChange={(value) => { if (value?.[0] && value[1]) setDateRange([value[0], value[1]]); }} /></label><div className="gov-filter-actions"><Button type="primary" icon={<SearchOutlined />} onClick={() => { setAuditPage(1); setAppliedFilters({ keyword, module, result, dateRange }); }}>查询</Button><Button icon={<ReloadOutlined />} onClick={() => { const nextRange = createDefaultDateRange(); setKeyword(""); setModule(undefined); setResult(undefined); setDateRange(nextRange); setAuditPage(1); setAppliedFilters({ keyword: "", module: undefined, result: undefined, dateRange: nextRange }); }}>重置</Button></div></div></Card>
      <Card className="content-card gov-content-card" styles={{ body: { padding: 0 } }}><ResultHeader title="操作审计" count={debugMode ? filtered.length : remoteAuditTotal} extra={<Typography.Text type="secondary">审计记录只读且不可删除</Typography.Text>} /><Table<AuditRecord> loading={remoteAuditLoading} rowKey="id" columns={columns} dataSource={filtered} scroll={{ x: 1080 }} pagination={{ current: auditPage, pageSize: auditPageSize, total: debugMode ? filtered.length : remoteAuditTotal, showSizeChanger: true, showTotal: (total) => `共 ${total} 条日志`, onChange: (nextPage, nextPageSize) => { setAuditPage(nextPageSize === auditPageSize ? nextPage : 1); setAuditPageSize(nextPageSize); } }} /></Card>
      <Drawer width={680} open={Boolean(detail)} onClose={() => setDetail(null)} title="审计详情">
        {detail ? <><div className="gov-audit-detail-head"><span className={`gov-audit-result is-${detail.result === "成功" ? "success" : "error"}`}>{detail.result === "成功" ? <CheckCircleOutlined /> : <StopOutlined />}</span><div><Typography.Title level={4}>{detail.action}</Typography.Title><Typography.Text type="secondary">{formatDisplayDateTime(detail.time)}</Typography.Text></div><StatusPill status={detail.result} /></div><Descriptions bordered column={2} size="small" items={[{ key: "operator", label: "操作人", children: `${detail.operator}（${detail.department}）` }, { key: "module", label: "所属模块", children: detail.module }, { key: "summary", label: "操作内容", span: 2, children: detail.summary }]} /><Alert className="gov-audit-summary" type="info" showIcon title="操作摘要" description={detail.detail} /></> : null}
      </Drawer>
    </div>
  );
}
