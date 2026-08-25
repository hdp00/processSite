# FlowPilot SQL Server 数据库结构设计

> 状态：已确认，作为后端 Entity、Migration、仓储和数据库验收的结构基线  
> 适用版本：Microsoft SQL Server 2016 SP2，数据库兼容级别 130  
> ORM：TypeORM Data Mapper；生产环境禁止 `synchronize` 和启动自动迁移

## 1. 建模原则

- 业务对象统一放在独立数据库 schema `flowpilot` 中，避免与数据库内其他系统对象混用。TypeORM Entity 必须显式声明 schema。
- 实体主键统一使用由应用生成的 `uniqueidentifier`；不得依赖 SQL Server 自增值生成领域 ID。流水号计数器等纯内部序列可以使用整数。
- 时间统一保存为 UTC `datetime2(3)`；接口返回 ISO 8601 UTC，界面再转换为业务时区 `Asia/Shanghai`。
- 可变聚合使用从 `1` 开始的 `int revision`。任何会改变该聚合 REST 表示、权限判断或后续命令结果的写入，都必须在同一事务中增加 revision。
- JSON 使用 `nvarchar(max)` 并增加 `ISJSON` 约束；JSON 是流程版本完整快照和实例最新表单值的事实来源，但不作为范围查询、排序和跨版本统计的主要索引来源。
- 账号、角色编码、权限编码、流程编码等唯一业务标识同时保存规范化值。规范化规则为去除首尾空白并使用 Unicode 小写；唯一约束建立在规范化列上，不仅依赖数据库排序规则。
- 新建专用数据库建议使用 DBA 批准的中文、大小写不敏感 Unicode 排序规则。实际排序规则通过 `MSSQL_EXPECTED_COLLATION` 配置并在迁移预检和就绪检查中核对；已有数据库不得由应用自行修改排序规则。
- 所有外键必须显式命名并确定删除行为。业务历史表默认 `NO ACTION`；只有纯关联表允许随父记录级联删除。
- 表名、列名、约束和索引均使用小写下划线命名；迁移脚本不得依赖 SQL Server 2017 以后能力。

## 2. 身份与组织

### 2.1 `flowpilot.users`

主要列：

- `id uniqueidentifier` 主键。
- `login_name nvarchar(100)`：界面显示和登录输入使用的规范账号，不包含密码或域地址。
- `normalized_login_name nvarchar(100)`：唯一索引。
- `display_name nvarchar(100)`、`email nvarchar(320)`。
- `authentication_mode nvarchar(20)`：`domain | password`。
- `password_hash nvarchar(500) null`：仅本地密码账号保存 Argon2id 编码字符串。
- `department_id uniqueidentifier null`、`position_id uniqueidentifier null`。
- `status nvarchar(20)`：`enabled | disabled`。
- `is_builtin_super_admin bit`：数据库内只能有一条为 `1`。
- `revision int`、`created_at`、`updated_at`、`created_by`、`updated_by`。

约束：

- `authentication_mode='password'` 时 `password_hash` 必须非空；`domain` 时必须为空。
- 内置超级管理员必须为 `password` 模式且不允许停用、删除或切换认证方式。
- 部门和职务使用 `NO ACTION` 外键；存在用户引用时不能删除，只能停用。
- 删除普通用户前必须确认不是当前登录账号，并检查角色、流程权限组、流程版本引用展开表、实例、任务、附件及其他历史业务外键。可变关联需要先显式解除；存在历史记录时只能停用。删除成功后在同一事务中撤销其全部会话，审计记录不得级联删除。

### 2.2 角色和权限

- `flowpilot.roles`：`id`、`code`、`normalized_code`、`name`、`description`、`status`、`is_builtin`、`revision` 和审计时间。
- `flowpilot.permissions`：稳定 `code` 主键或唯一键、资源、动作、名称、排序、是否内置。权限目录由版本化种子维护，不允许页面创建任意权限代码。
- `flowpilot.user_roles`：`user_id + role_id` 联合唯一，保存授权人和授权时间。
- `flowpilot.role_permissions`：`role_id + permission_code` 联合唯一，保存授权人和授权时间。

删除角色前必须确认没有用户关联、流程权限组关联、流程版本引用或运行实例资格依赖。删除用户和角色分别受独立动作权限控制。纯关联行可以随已获准删除的角色级联删除，业务审计不得级联删除。

### 2.3 部门和职务

- `flowpilot.departments`：`id`、稳定 `code`、`normalized_code`、`name`、`parent_id`、`path_cache`、`sort_order`、`status`、`description`、`revision`。
- `flowpilot.positions`：`id`、稳定 `code`、`normalized_code`、`name`、`sort_order`、`status`、`description`、`revision`。

部门层级必须拒绝循环引用。`path_cache` 只用于列表显示和搜索，更新父部门时在同一事务中重算受影响子树；权限判断使用稳定部门 ID，不依赖显示路径。

### 2.4 流程权限组

- `flowpilot.workflow_permission_groups`：`id`、`code`、`normalized_code`、`name`、`description`、`status`、`revision`。
- `flowpilot.workflow_group_users`：直接成员，`group_id + user_id` 联合唯一。
- `flowpilot.workflow_group_roles`：关联角色，`group_id + role_id` 联合唯一。

有效成员在查询时由直接成员与有效角色成员并集计算。流程版本不复制成员名单，只保存稳定组 ID；停用或成员变化需要通过影响预览检查运行待办和发起/关闭资格。

## 3. 流程定义与版本

### 3.1 `flowpilot.workflow_definitions`

主要列：`id`、`code`、`normalized_code`、`name`、`description`、`type`、`status`、`published_version_id null`、`next_version_number`、`instance_count`、`revision` 和审计时间。

- `code` 全局唯一且创建后不可修改。
- `published_version_id` 必须属于当前定义；该一致性由同一发布事务和仓储契约保证。
- `instance_count` 是可重建缓存，实例创建事务内递增；验收工具必须能与实例事实表核对。

### 3.2 `flowpilot.workflow_definition_versions`

主要列：

- `id`、`definition_id`、`version_number`、`version_label`。
- `basic_json nvarchar(max)`、`snapshot_json nvarchar(max)`。
- `validation_status`、`validation_json nvarchar(max)`、`validated_at`。
- `status`、`instance_count`、`revision`。
- 创建、更新、首次发布、最近发布和取消发布的操作者、时间与原因。

约束与索引：

- `(definition_id, version_number)` 唯一。
- 三个 JSON 列分别增加 `ISJSON` 约束；可空 JSON 约束写成 `column IS NULL OR ISJSON(column)=1`。
- 已产生实例或已发布的版本不允许编辑完整快照，也不允许物理删除。
- 每个正式版本保存完整自包含快照，不保存相对上一版本的差异。

### 3.3 版本引用展开表

为避免通过 JSON 扫描执行治理影响分析，保存以下可重建引用：

- `flowpilot.workflow_version_group_refs`：`version_id`、`group_id`、`purpose`、`node_id null`。
- `flowpilot.workflow_version_role_refs`：`version_id`、`role_id`、`purpose`。
- `flowpilot.workflow_version_field_catalog`：`version_id`、稳定字段 ID、表格列 ID、名称、类型、查询/列表/导出标记和输入阶段。

引用展开表与版本 JSON 在同一事务中写入，可由版本 JSON 幂等重建。它们不是版本快照的替代品。

## 4. 流程实例、任务与投影

### 4.1 `flowpilot.workflow_instances`

主要列：

- `id`、`instance_number`、`definition_id`、`version_id`。
- `initiator_user_id`、`actual_initiator_user_id`，用于模拟身份场景保留生效用户和真实操作者。
- `title`、`status`、`current_round`、`current_node_summary`。
- `form_values_json nvarchar(max)`、`field_revisions_json nvarchar(max)`。
- `created_at`、`submitted_at`、`completed_at`、`closed_at`、`revision`。

`instance_number` 全局唯一。定义、版本、发起人均使用 `NO ACTION` 外键。实例永久保留，不提供物理删除。

### 4.2 `flowpilot.instance_field_values`

用于动态标量字段查询，主要列：

- `instance_id`、`definition_id`、`version_id`。
- `field_id`、`table_field_id null`、`column_id null`、`row_id null`。
- `value_type`。
- 互斥的 `text_value nvarchar(2000)`、`number_value decimal(38,10)`、`datetime_value datetime2(3)`、`boolean_value bit`、`option_id nvarchar(200)`。

必须通过 CHECK 约束保证只有与 `value_type` 对应的值列非空。普通字段 `(instance_id, field_id)` 唯一；表格列按 `(instance_id, table_field_id, row_id, column_id)` 唯一。

主要索引：

- `(definition_id, field_id, text_value, instance_id)`；
- `(definition_id, field_id, number_value, instance_id)`；
- `(definition_id, field_id, datetime_value, instance_id)`；
- `(definition_id, field_id, option_id, instance_id)`；
- `(instance_id, field_id)`。

文本超过投影列长度时仍完整保存在 JSON，但不得把该字段配置为普通文本精确查询；实现需返回清晰的发布校验错误，不能静默截断。

### 4.3 `flowpilot.workflow_tasks`

主要列：`id`、`instance_id`、`version_id`、`node_id`、`node_name_snapshot`、`group_id`、`default_assignee_id null`、`actual_assignee_id null`、`round`、`status`、`action null`、`result_comment null`、`activated_at`、`completed_at`、`revision`。

- `(instance_id, node_id, round)` 建立唯一或与业务允许的并行任务模型等价的唯一约束。
- 待办领取和处理必须使用 `status='pending'`、revision 与锁定条件实现 first-writer-wins。
- 用户、流程组被停用不得改变历史快照；运行任务的重新分配必须通过显式领域命令产生审计。

### 4.4 事件和审计

- `flowpilot.workflow_events`：实例时间线，只追加；保存事件类型、实例、任务、节点、轮次、真实操作者、生效用户、发生时间和经过裁剪的事件元数据 JSON。
- `flowpilot.audit_events`：平台级治理审计，只追加；保存资源类型、资源 ID、动作、字段标识与名称、真实操作者、生效用户、traceId、结果和时间。

两张表不得保存密码、会话令牌、附件正文、完整表单值、字段修改前后业务值或自由协作回复旧正文。

### 4.5 `flowpilot.number_counters`

按 `(prefix, year_month)` 唯一，保存 `next_value` 和 revision。编号分配在实例创建事务内使用 `SERIALIZABLE` 或 `UPDLOCK/HOLDLOCK`，成功提交后才消耗号码；同一幂等请求重放不得再次分配。

## 5. 附件

### 5.1 `flowpilot.attachments`

主要列：

- `id`、`state`、`storage_year`、`storage_key`。
- `original_file_name`、`extension`、`declared_content_type`、`detected_content_type`。
- `size_bytes`、`sha256`、`purpose`。
- `uploaded_by`、`created_at`、`staged_at`、`cleanup_after null`、`last_error null`、`revision`。

`storage_key` 全局唯一，只允许相对路径；不得保存盘符或附件根目录。状态限定为 `uploading | staged | active | cleanup-pending | failed | deleted`。

### 5.2 `flowpilot.attachment_references`

保存 `attachment_id`、`instance_id`、`field_id null`、`table_row_id null`、`free_timeline_entry_id null`、`reference_type`、创建人和时间。相同业务槽位只能存在一个当前有效引用；替换通过创建新引用并使旧附件进入待清理状态实现，不覆盖物理文件。

删除物理文件前必须再次查询有效引用。附件元数据不因物理删除失败而提前删除。

## 6. 会话、幂等和后台任务

### 6.1 会话与模拟身份

- `flowpilot.sessions`：`id`、`token_hash` 唯一、`operator_user_id`、`effective_user_id`、权限快照版本、创建/最近访问/闲置过期/绝对过期时间、撤销时间和撤销原因。只保存令牌散列。
- `flowpilot.impersonation_records`：超级管理员、目标用户、原因、开始/结束时间、开始/结束 traceId，只追加状态变化。

### 6.2 幂等记录

`flowpilot.idempotency_records` 保存 `actor_id`、`route_scope`、`idempotency_key`、请求摘要、处理状态、首次 HTTP 状态码、允许重放的响应头、响应体 JSON、创建和过期时间。

- `(actor_id, route_scope, idempotency_key)` 唯一。
- 同键同摘要返回首次结果；同键不同摘要返回 `409 IDEMPOTENCY_KEY_REUSED`。
- `processing` 记录超过租约时间可由同一请求接管；未超时的并发重复请求返回 `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`，不在数据库事务中长时间等待。

### 6.3 邮件 Outbox

- `flowpilot.email_outbox`：`id`、revision、业务事件唯一键、事件类型、`instance_id`、可空 `task_id`、模板、收件人用户与邮箱快照、主题、经过最小化的模板数据 JSON、`target_path`、可空 `resolved_target_url`、状态、计划时间、尝试次数、租约、最后错误、创建/发送/死信时间。`target_path` 只允许 `/processes/{instanceId}` 及受控 `taskId` 查询参数；不得保存任意外部 URL。
- `flowpilot.email_delivery_attempts`：`id`、`outbox_id`、尝试序号、开始/结束时间、结果、经过脱敏的错误类别和服务器响应摘要；`(outbox_id, attempt_number)` 唯一。

业务事务只写 Outbox。SMTP 发送、重试和死信转换在事务提交后执行。worker 第一次领取记录时使用 `FLOWPILOT_PUBLIC_BASE_URL` 和 `target_path` 解析绝对链接，在发送前把结果写入 `resolved_target_url`；后续重试复用同一快照，避免配置变化导致同一邮件重试内容不同。数据库保存投递所需的最小模板数据和实际链接，但不保存完整 MIME、完整渲染正文、业务附件、SMTP 密码或会话凭据。

### 6.4 后台租约和结构版本

- `flowpilot.job_leases`：`job_name` 主键、`owner_id`、`lease_until`、`heartbeat_at`、最近成功/失败时间和摘要。
- `flowpilot.schema_migrations`：迁移 ID、名称、校验和、开始/完成时间、执行工具版本和结果。
- `flowpilot.system_state`：稳定种子版本、投影结构版本和其他少量系统级版本标记；不得用于保存任意秘密配置。

## 7. 删除和保留规则

- 流程实例、被实例引用的版本、任务、业务事件和审计永久保留。
- 用户、部门、职务、角色和流程权限组有历史引用时只允许停用。
- 没有发布版本、没有实例且通过影响检查的流程定义可以物理删除；其未使用版本和纯引用展开表在同一事务中删除。
- 暂存附件和无引用替换附件按状态机延迟清理；不得通过数据库级联直接删除物理文件。
- 已发送 Outbox、幂等记录、过期会话和技术日志按照需求中的保留期由后台任务清理。
- 所有删除命令必须先写审计，且审计记录不随业务对象删除。

## 8. 迁移和验收要求

- 首次迁移依次创建 schema、基础表、外键、CHECK、唯一约束、查询索引和内置种子。
- 每次迁移具有固定 ID 和校验和；已经在任何环境执行过的迁移文件不得改写，只能新增后续迁移。
- 迁移账号拥有 DDL 权限；应用运行账号只拥有 `flowpilot` schema 内所需的 DML 和执行权限。
- 空数据库迁移、从上一结构版本升级、失败回滚或前向修复都必须在 SQL Server 2016 SP2、兼容级别 130 环境验证。
- 验收至少核对外键、唯一约束、JSON 合法性、投影一致性、任务状态、编号连续性、附件引用、Outbox、会话撤销和结构校验和。
- 具体列长、索引 INCLUDE 列和查询执行计划在实现阶段根据真实查询补充，但不得改变本文件规定的聚合边界和事实来源。
