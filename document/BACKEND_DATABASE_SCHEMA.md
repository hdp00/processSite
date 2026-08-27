# FlowPilot SQL Server 数据库结构设计

> 状态：已确认，作为后端持久化、Migration 和数据库验收的结构基线
> 适用版本：Microsoft SQL Server 2016 SP2 及之后版本，数据库兼容级别不低于 130
> ORM：EF Core 10；生产环境禁止启动自动迁移

## 1. 建模原则

- 业务对象统一放在独立数据库 schema `flowpilot` 中，避免与数据库内其他系统对象混用。EF Core 持久化实体映射必须显式声明 schema。
- 实体主键统一使用由应用生成的 `uniqueidentifier`；不得依赖 SQL Server 自增值生成领域 ID。流水号计数器等纯内部序列可以使用整数。
- 时间统一保存为 UTC `datetime2(3)`；接口返回 ISO 8601 UTC，界面再转换为业务时区 `Asia/Shanghai`。
- 可变聚合使用从 `1` 开始的 `int revision`。任何会改变该聚合 REST 表示、权限判断或后续命令结果的写入，都必须在同一事务中增加 revision。
- JSON 使用 `nvarchar(max)` 并增加 `ISJSON` 约束；JSON 是流程版本完整快照和实例最新表单值的事实来源，但不作为范围查询、排序和跨版本统计的主要索引来源。
- 账号、角色编码、权限编码、流程编码等唯一业务标识同时保存规范化值。规范化算法由应用中的单一实现完成，固定为 Unicode NFKC、去除首尾空白并使用 invariant 小写；写入、登录和查询必须复用同一算法。唯一约束建立在规范化列上，不仅依赖数据库排序规则。
- 只有启用/停用两种业务状态的主数据使用 `is_enabled bit`；API 层将其映射为 `status: enabled | disabled`，不得为迁就传输枚举在数据库中保存重复字符串。流程实例、任务、版本、附件和 Outbox 等多阶段生命周期对象继续使用受 CHECK 约束的 `status` 或 `state` 枚举列。
- 新建专用数据库建议使用 DBA 批准的中文、大小写不敏感 Unicode 排序规则。实际排序规则通过外置 `FlowPilot:Database:ExpectedCollation` 配置并在迁移预检和就绪检查中核对；已有数据库不得由应用自行修改排序规则。
- 迁移预检和就绪检查必须读取 `SERVERPROPERTY('ProductVersion')` 与 `SERVERPROPERTY('ProductLevel')`；SQL Server 2016 主版本 13 只接受 SP2/SP3，主版本 14 及以上接受；数据库兼容级别必须不低于 130。诊断不得输出服务器地址或连接凭据。所有 DDL、约束和查询仍以 SQL Server 2016 SP2/兼容级别 130 为最低能力基线，不得按较新服务器版本产生不同业务结构。
- SQL Server 连接必须显式配置安全选项，不依赖 SqlClient 版本默认值。远程连接默认 `Encrypt=true;TrustServerCertificate=false` 并校验证书链与主机名；只有经部署记录批准的同机回环例外才允许降低该要求。连接字符串和证书细节不得进入日志、错误响应或健康接口。
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
- `password_hash nvarchar(500) null`：仅本地密码账号保存 ASP.NET Core `PasswordHasher<TUser>` 生成的自描述、版本化编码字符串；应用通过 `SuccessRehashNeeded` 处理参数升级，不由数据库解释内部格式。
- `department_id uniqueidentifier`、`position_id uniqueidentifier`：均为必填外键；任何用户都必须归属一个有效部门和职务。
- `is_enabled bit`：`1` 表示启用，`0` 表示停用；API 映射为 `enabled | disabled`。
- `is_builtin_super_admin bit`：数据库内只能有一条为 `1`。
- `revision int`、`created_at`、`updated_at`、`created_by`、`updated_by`。

约束：

- `authentication_mode='password'` 时 `password_hash` 必须非空；`domain` 时必须为空。
- 内置超级管理员必须为 `password` 模式且不允许停用、删除或切换认证方式。
- 使用 `WHERE is_builtin_super_admin=1` 的筛选唯一索引保证至多一条内置超级管理员记录；首次种子与就绪检查必须保证正式数据库恰好存在一条，不能只依赖应用内约定。
- 部门和职务使用 `NO ACTION` 外键；存在用户引用时不能删除，只能停用。
- 删除普通用户前必须确认不是当前登录账号，并检查角色、流程权限组、流程版本引用展开表、实例、任务、附件及其他历史业务外键。可变关联需要先显式解除；存在历史记录时只能停用。删除成功后在同一事务中撤销其全部会话，审计记录不得级联删除。

### 2.2 角色和权限

- `flowpilot.roles`：`id`、`code`、`normalized_code`、`name`、`normalized_name`、`description`、`is_enabled bit`、`is_builtin`、`revision` 和审计时间；角色名称按应用统一规范化规则建立唯一索引，避免并发重名且不依赖数据库排序规则。
- `flowpilot.permissions`：稳定 `code` 主键或唯一键、资源、动作、名称、排序、是否内置。权限目录由版本化种子维护，不允许页面创建任意权限代码。
- `flowpilot.user_roles`：`user_id + role_id` 联合唯一，保存授权人和授权时间。
- `flowpilot.role_permissions`：`role_id + permission_code` 联合唯一，保存授权人和授权时间。

删除角色前必须确认没有用户关联、流程权限组关联、流程版本引用或运行实例资格依赖。用户、角色、部门/职务和流程权限组删除分别受独立动作权限控制，普通编辑权限不能替代删除。纯关联行可以随已获准删除的角色级联删除，业务审计不得级联删除。

### 2.3 部门和职务

- `flowpilot.departments`：`id`、稳定 `code`、`normalized_code`、`name`、`parent_id`、`path_cache`、`sort_order`、`is_enabled bit`、`description`、`revision`。
- `flowpilot.positions`：`id`、稳定 `code`、`normalized_code`、`name`、`normalized_name`、`sort_order`、`is_enabled bit`、`description`、`revision`；职务名称按应用统一规范化规则建立唯一索引。

部门层级必须拒绝循环引用。`path_cache` 只用于列表显示和搜索，更新父部门时在同一事务中重算受影响子树；权限判断使用稳定部门 ID，不依赖显示路径。

### 2.4 流程权限组

- `flowpilot.workflow_permission_groups`：`id`、`code`、`normalized_code`、`name`、`description`、`is_enabled bit`、`revision`。
- `flowpilot.workflow_permission_group_purposes`：`group_id + purpose` 联合主键，`purpose` 限定为 `start | review | close`；只允许随权限组级联删除。
- `flowpilot.workflow_group_users`：直接成员，`group_id + user_id` 联合唯一。
- `flowpilot.workflow_group_roles`：关联角色，`group_id + role_id` 联合唯一。

权限组创建和更新必须在同一事务中保证至少存在一个用途；数据库关系保证用途不可重复，领域校验保证不得提交空集合。有效成员在查询时由直接成员与有效角色成员并集计算。流程版本不复制成员名单，只保存稳定组 ID；停用或成员变化需要通过影响预览检查运行待办和发起/关闭资格。

## 3. 流程定义与版本

### 3.1 `flowpilot.workflow_definitions`

主要列：`id`、`code`、`normalized_code`、`name`、`description`、`type`、`is_disabled bit`、`published_version_id null`、`next_version_number`、`instance_count`、`revision` 和审计时间。

- `code` 全局唯一且创建后不可修改。
- `published_version_id` 必须属于当前定义；该一致性由同一发布事务和应用服务保证。
- API 的 `unpublished | published | disabled` 定义状态由 `is_disabled` 与 `published_version_id` 推导，不在数据库重复保存可相互冲突的状态字符串。
- `instance_count` 是可重建缓存，实例创建事务内递增；验收工具必须能与实例事实表核对。

### 3.2 `flowpilot.workflow_definition_versions`

主要列：

- `id`、`definition_id`、`version_number`、`version_label`。
- `basic_json nvarchar(max)`、`snapshot_json nvarchar(max)`。
- `validation_status`、`validation_json nvarchar(max)`、`validated_at`。
- `instance_count`、`revision`。
- 创建、更新、首次发布、最近发布和取消发布的操作者、时间与原因。

约束与索引：

- `(definition_id, version_number)` 唯一。
- 三个 JSON 列分别增加 `ISJSON` 约束；可空 JSON 约束写成 `column IS NULL OR ISJSON(column)=1`。
- 版本不保存可与发布指针或校验结果冲突的通用 `status`。API 展示的“已发布 / 可发布 / 校验未通过”等状态由定义的 `published_version_id`、`validation_status` 和停用状态推导。
- 已产生实例或已发布的版本不允许编辑完整快照，也不允许物理删除。
- 每个正式版本保存完整自包含快照，不保存相对上一版本的差异。

### 3.3 版本引用展开表

为避免通过 JSON 扫描执行治理影响分析，保存以下可重建引用：

- `flowpilot.workflow_version_group_refs`：`version_id`、`group_id`、`purpose`、`node_id null`。
- `flowpilot.workflow_version_role_refs`：`version_id`、`role_id`、`purpose`；额外可见角色固定使用 `purpose = visible`。
- `flowpilot.workflow_version_field_catalog`：`version_id`、稳定字段 ID、表格列 ID、名称、类型、查询/列表/导出标记和输入阶段。

引用展开表与版本 JSON 在同一事务中写入，可由版本 JSON 幂等重建。它们不是版本快照的替代品。

## 4. 流程实例、任务与投影

### 4.1 `flowpilot.workflow_instances`

主要列：

- `id`、`instance_number`、`definition_id`、`version_id`。
- `initiator_user_id`、`actual_initiator_user_id`，用于模拟身份场景保留生效用户和真实操作者。
- `title`、`status`、`current_round`、`current_node_summary`、可空 `current_assignee_id`、可空 `verified_entry_base_url`。
- `form_values_json nvarchar(max)`、`field_revisions_json nvarchar(max)`。
- `created_at`、`updated_at`、`submitted_at`、`completed_at`、`closed_at`、`revision`。

`instance_number` 全局唯一。定义、版本、发起人和当前受理人均使用 `NO ACTION` 外键。固定审批实例的 `current_assignee_id` 为空；自由协作进行中时必须与唯一待处理自由协作任务的责任人一致，关闭时为空。任何成功改变用户可见实例内容、当前责任或生命周期的命令都必须在同一事务更新 `updated_at`。实例永久保留，不提供物理删除。`verified_entry_base_url` 只能由通过同源校验的浏览器业务写请求写入或刷新，保存该实例最近一次已验证的 `${origin}/flowpilot`，供以后没有浏览器请求上下文的事件继承；不得接受客户端正文中的地址。

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

任务中心统一保存三类任务。主要列：

- 公共列：`id`、`task_type`、`instance_id`、`version_id`、`assignee_id null`、`round`、`status`、`activated_at`、`completed_at`、`revision`。
- 审批任务专用列：`node_id null`、`node_name_snapshot null`、`group_id null`、`default_assignee_id null`、`actual_assignee_id null`、`action null`、`result_comment null`。
- `task_type` 限定为 `approval | free-collaboration | resubmission`。审批任务必须填写节点和权限组；自由协作任务必须填写唯一当前 `assignee_id` 且不填写节点；重新提交任务的 `assignee_id` 必须是实例实际创建人，且不填写审批节点。
- `status` 限定为 `inactive | pending | completed | cancelled | skipped`。`inactive` 和 `skipped` 只适用于审批任务；自由协作和重新提交任务只能使用 `pending | completed | cancelled`。

- 审批任务按 `(instance_id, node_id, round)` 建立筛选唯一索引。
- 自由协作和重新提交任务分别使用筛选唯一索引保证同一实例同一类型最多存在一个 `pending` 任务；转交、改派、关闭和重新打开必须在同一事务中完成旧任务状态变化、新任务创建及实例当前受理人更新。
- 待办领取和处理必须使用 `status='pending'`、revision 与锁定条件实现 first-writer-wins。
- 用户、流程组被停用不得改变历史快照；运行任务的重新分配必须通过显式领域命令产生审计。

### 4.4 自由协作事实与投影

- `flowpilot.free_timeline_entries`：`id`、`instance_id`、`entry_type`、`actor_user_id`、可空 `related_entry_id`、可空 `content`、可空 `previous_assignee_id`、可空 `assignee_id`、可空 `reason`、可空 `field_changes_json`、`occurred_at`、可空 `edited_by`、可空 `edited_at`、`revision`。`entry_type` 至少包含 `created | reply | reply-edited | transferred | form-edited | reassigned | closed | reopened`；`reply-edited` 必须通过同表 `NO ACTION` 外键 `related_entry_id` 指向被编辑回复。
- 回复正文只保存在原 `entry_type='reply'` 行的 `content` 中，编辑时覆盖为最新正文并更新编辑人、编辑时间和 revision；另追加不含旧正文的 `reply-edited` 事件。不得创建保存旧正文的回复修订表。
- `flowpilot.free_participants`：`instance_id + user_id` 联合主键，保存首次/最近参与时间及参与来源位集合；它是由发起人、所有历史受理人和回复作者事务内维护的查询投影，可从实例和自由协作时间线重建。
- 自由协作实例、任务、时间线、参与人投影、附件引用和 `updated_at` 必须在同一领域事务内保持一致。时间线和参与人事实永久保留，不因用户停用或事项关闭删除。

### 4.5 事件和审计

- `flowpilot.workflow_events`：实例时间线，只追加；保存事件类型、实例、任务、节点、轮次、真实操作者、生效用户、发生时间和经过裁剪的事件元数据 JSON。
- `flowpilot.audit_events`：平台级治理审计，只追加；保存资源类型、资源 ID、动作、字段标识与名称、真实操作者、生效用户、traceId、结果和时间。

两张表不得保存密码、会话令牌、附件正文、完整表单值、字段修改前后业务值或自由协作回复旧正文。

### 4.6 `flowpilot.number_counters`

按 `(prefix, year_month)` 唯一，保存 `next_value` 和 revision。编号分配在实例创建事务内使用 `SERIALIZABLE` 或 `UPDLOCK/HOLDLOCK`，成功提交后才消耗号码；同一幂等请求重放不得再次分配。

## 5. 附件

### 5.1 `flowpilot.attachments`

主要列：

- `id`、`state`、`storage_year`、`storage_key`。
- `original_file_name`、`extension`、`declared_content_type`、`detected_content_type`。
- `size_bytes`、`sha256`、`purpose`。
- `uploaded_by`、`created_at`、`staged_at`、`cleanup_after null`、`last_error null`、`revision`。

`storage_key` 全局唯一，只允许相对路径；不得保存盘符或附件根目录。状态限定为 `uploading | staged | active | cleanup-pending | failed | deleted`：上传完成且尚未建立业务引用为 `staged`，存在有效业务引用为 `active`。普通业务 API 只投影 `staged | active | cleanup-pending`，内部恢复和运维使用其余状态。

`storage_key` 始终指向数据库已知的实际文件位置。业务引用事务把 `staged` 改为 `active` 时不预先改成尚不存在的对象键；提交后的移动 worker 完成同卷原子移动后，再以短事务更新为正式键。恢复逻辑必须能够识别“文件已移动但键尚未更新”和“引用已提交但尚未移动”两种中断点，并以大小和 SHA-256 核对后幂等修复。

附件 GUID 统一格式化为小写 32 位 `attachmentIdN`，分片 `shard` 固定取其前两位。临时键为 `{yyyy}/.incoming/{attachmentIdN}.part`，正式键为 `{yyyy}/objects/{shard}/{attachmentIdN}`。`storage_year` 和相对键在创建时按 `Asia/Shanghai` 固化；该算法必须由单一存储服务实现并加入兼容性测试，原始文件名和扩展名不得参与物理路径。

### 5.2 `flowpilot.attachment_references`

保存 `attachment_id`、`instance_id`、`field_id null`、`table_row_id null`、`free_timeline_entry_id null`、`reference_type`、创建人和时间。`free_timeline_entry_id` 明确外键到 `flowpilot.free_timeline_entries`。相同业务槽位只能存在一个当前有效引用；替换通过创建新引用并使旧附件进入待清理状态实现，不覆盖物理文件。

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

- `flowpilot.email_outbox`：`id`、revision、业务事件唯一键、事件类型、`instance_id`、可空 `task_id`、模板、收件人用户与邮箱快照、主题、经过最小化的模板数据 JSON、`target_path`、可空 `link_base_url`、可空 `resolved_target_url`、状态、计划时间、尝试次数、租约、最后错误、创建/发送/死信时间。浏览器写请求产生事件时，`link_base_url` 只能保存后端同源校验成功后自动得到的 `${origin}/flowpilot`；无请求事件只能继承实例的 `verified_entry_base_url`。两者都不存在时记录明确的死信/配置错误且不得发送。`target_path` 只允许 `/processes/{instanceId}` 及受控 `taskId` 查询参数；不得接受或保存客户端提供的任意外部 URL。
- `flowpilot.email_delivery_attempts`：`id`、`outbox_id`、尝试序号、开始/结束时间、结果、经过脱敏的错误类别和服务器响应摘要；`(outbox_id, attempt_number)` 唯一。

Outbox 的业务事件唯一键必须包含事件稳定标识、激活序号和收件人稳定标识；数据库对最终 `idempotency_key` 建立唯一约束。同一业务事件向多个收件人发送时生成不同键，同一收件人的接口重试或 worker 重启复用同一键。

业务事务只写 Outbox。触发业务事件的浏览器写请求在通过 CSRF 来源校验后，将来源 origin 与可信代理后的 protocol/host 精确比较，并把自动得到的 `${origin}/flowpilot` 同时保存为 Outbox `link_base_url` 和实例 `verified_entry_base_url`；没有浏览器请求上下文的事件继承实例值。没有可继承值时仍保留可追踪的失败记录并进入死信，不得回退到 loopback、服务器名、客户端正文或未经校验的请求头。SMTP 发送、重试和死信转换在事务提交后执行。worker 第一次领取记录时使用已冻结的 `link_base_url` 和 `target_path` 解析绝对链接，在发送前把结果写入 `resolved_target_url`；后续重试复用同一快照，避免入口变化导致同一邮件重试内容不同。数据库保存投递所需的最小模板数据和实际链接，但不保存完整 MIME、完整渲染正文、业务附件、SMTP 密码或会话凭据。

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

- 首次迁移依次创建 schema、基础表、外键、CHECK、唯一约束和查询索引；EF Core migration 作为结构演进依据，生产由 DBA 执行已审查 SQL，业务结构版本和校验和记录在 `flowpilot.schema_migrations`。
- 结构迁移完成后由独立事务型种子 CLI 幂等创建系统内置部门/职务、初始职务“经理”“员工”、唯一超级管理员角色及账号、内置权限和关联。首次创建超级管理员时只从仓库外 Secrets JSON 读取初始密码并通过 `PasswordHasher<TUser>` 保存散列；重复执行不得覆盖已有密码。
- 就绪检查验证结构版本和 `builtin-seed` 版本与当前构建一致；权限目录、超级管理员及其关联由幂等种子事务一次性维护，数据库约束负责唯一性和引用完整性。
- 每次迁移具有固定 ID 和校验和；校验和由不含 ledger/state 自引用写入语句的规范化 schema DDL 集合在模块加载时计算 SHA-256，避免手工常量与实际 DDL 漂移。已经在任何环境执行过的迁移文件不得改写，只能新增后续迁移。
- 迁移账号拥有 DDL 权限；应用运行账号只拥有 `flowpilot` schema 内所需的 DML、执行权限、迁移/种子版本读取权限，以及核对表、列、具名约束、显式索引和触发器名称所需的元数据可见性，不拥有 DDL 权限。
- 空数据库迁移、从上一结构版本演进、失败回滚或前向修复都必须在 SQL Server 2016 SP2、兼容级别 130 最低基线上验证，并在实际部署的较新 SQL Server 版本/兼容级别上复验；不使用 SQLite、EF InMemory 或单独的较新版本替代最低基线验收。
- 验收至少核对外键、唯一约束、JSON 合法性、投影一致性、任务状态、编号连续性、附件引用、Outbox、会话撤销和结构校验和。
- 具体列长、索引 INCLUDE 列和查询执行计划在实现阶段根据真实查询补充，但不得改变本文件规定的聚合边界和事实来源。
