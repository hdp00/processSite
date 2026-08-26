# FlowPilot 后端实施决策与开工清单

> 状态：产品和架构方向已确认。真实账号、密码、域地址、SQL Server 地址、SMTP 地址和服务器路径由部署人员在后端完成后填写配置文件，不进入 Git。

## 1. 固定技术与工程结构

- 后端工作区使用 `apps/api`，包名建议为 `@process-site/api`；共享 OpenAPI 生成物放在独立 workspace 包中，不由页面或 NestJS DTO 手工复制。
- `apps/api/package.json` 固定设置 `"type": "module"`，TypeScript 固定使用 `module: "NodeNext"` 和 `moduleResolution: "NodeNext"`；TypeORM Migration、Vitest、维护 CLI、构建产物和 WinSW 启动入口全部按 ESM 验证。
- 生产运行时使用 Node.js 24 LTS x64，并在开始实现时将具体补丁版本写入仓库运行时版本文件和部署清单。升级补丁版本必须重新执行 Windows Server 2016 冒烟测试。
- 版本依据以 Node.js 官方的 [发布状态](https://nodejs.org/en/about/previous-releases) 和 [v24.x 支持平台](https://github.com/nodejs/node/blob/v24.x/BUILDING.md#platform-list) 为准；如果服务器操作系统或 Node.js 支持状态变化，部署前必须重新评估，不能通过跳过平台检查强行运行。
- NestJS、TypeORM 0.3、`@nestjs/typeorm`、`mssql`、TypeScript 和所有生成器使用精确版本写入 package manifest 和 lockfile；生产依赖不得使用未锁定的全局安装。
- 配置使用 `@nestjs/config` 加载，使用 Zod 在启动时校验。稳定且非敏感的默认值保存在随代码发布的 `apps/api/config/defaults.env`，外置 Secrets、外置 Config 和进程环境变量按优先级覆盖。日志使用 `nestjs-pino` 输出结构化 JSON 到标准输出，由 WinSW 负责服务日志滚动。
- Windows 服务固定使用 WinSW 包装 Node.js 进程。服务使用独立低权限账号，自动重启次数和退避由 WinSW 与 Windows 服务恢复策略共同配置。
- 正式构建、数据库迁移、离线维护命令和 API 启动使用不同入口，但复用同一配置校验和依赖注入模块。

### 1.1 生产依赖白名单

- NestJS 与集成：`@nestjs/common`、`@nestjs/core`、`@nestjs/platform-express`、`@nestjs/config`、`@nestjs/typeorm`、`@nestjs/schedule`。
- 数据与配置：`typeorm`、`mssql`、`zod`；`mssql` 固定使用默认纯 JavaScript `tedious`，不得安装 `msnodesqlv8`。
- 基础设施：`ldapts`、`nodemailer`、`axios`、`pino`、`nestjs-pino`。
- 文件与 HTTP 安全：`busboy`、`file-type`、`yauzl`、`sanitize-html`、`content-disposition`、`helmet`、`cookie-parser`。
- `axios` 直接封装，不增加 `@nestjs/axios`；统一配置超时、最大响应体、目标地址白名单、敏感请求头隔离和仅针对安全/幂等请求的受控重试。禁止接受用户提供的完整目标 URL。
- 密码派生、UUID、随机数、摘要、路径和文件流优先使用 Node.js 内置模块；禁止 `argon2`、`bcrypt`、`msnodesqlv8` 以及任何依赖 `node-gyp`、Visual Studio、ODBC 或运行时下载二进制文件的生产模块。
- 不引入 Redis/BullMQ、RabbitMQ、Kafka、Passport/JWT、`express-session`、`@nestjs/swagger`、`@nestjs/terminus`、`@nestjs/throttler`、`class-validator`、`class-transformer`、`nestjs-zod`、TypeORM CLS/事务扩展、模板引擎、日期工具库、`uuid`、`fs-extra` 或 SWC 原生加速器。
- `@redocly/cli`、`orval`、`@nestjs/cli`、`@nestjs/testing`、Vitest、`supertest`、`smtp-server`、TypeScript 和类型声明只放开发依赖，不复制到生产运行包。
- 新增白名单外依赖前必须记录必要性、替代方案、传递依赖、安装脚本和目标服务器验证结果；依赖树新增 `.node` 文件或本机编译步骤时阻断发布。

## 2. 正式 API 契约决策

- 唯一正式基础路径为 `/api/flowpilot/v1`。
- 正式 OpenAPI 全局只声明 `flowpilot_session` HttpOnly Cookie；Mock Bearer 只属于 Debug Mock 文档和浏览器适配层。
- 健康接口固定为：
  - `GET /health/live`：匿名存活检查，只证明进程可响应，不访问外部依赖。
  - `GET /health/ready`：匿名就绪检查，检查配置、数据库连接、兼容级别和结构版本；失败返回 `503`，不返回秘密或内部地址。
  - `GET /health/details`：要求已登录且具有系统运维查看权限；当前切片返回数据库、schema、AD/LDAP 和 SMTP 脱敏状态，附件磁盘、后台任务、死信和清理状态随对应模块实现后加入。
- 流程定义导出使用 `GET /process-definitions/{definitionId}/export`，返回可下载 JSON 文档；导入继续使用 `POST /process-definitions/imports`。
- 附件内容接口支持单区间 `Range`，完整内容返回 `200`、合法单区间返回 `206`、非法或多区间返回 `416`。磁盘保留空间不足返回 `507`。
- 自由协作初始表单修改使用 `PATCH`；删除暂存附件必须携带打开元数据时取得的 `If-Match`。
- 角色和流程权限组影响预览必须提交将要应用的变更请求体，不能发送空请求让服务端猜测。
- 动态查询字段使用 OpenAPI `deepObject` 语义；前端必须使用生成客户端或经过契约测试的编码器，禁止把对象直接转换为字符串。
- 空查询结果属于成功结果。Excel 数据集允许 `rowCount=0` 和空 `rows`，列结构仍按当前发布版本返回。

## 3. 前端正式接入边界

- 正式模式不得继续保存或发送 `flowpilot-api-access-token`；浏览器依靠同源 Cookie，会话令牌不可被 JavaScript 读取。
- 启动只加载当前会话、权限目录、当前用户必要角色/流程权限组和少量组织字典。
- 用户、实例、任务、审计、邮件 Outbox 和其他会持续增长的数据必须服务端分页、筛选和排序，不得在登录时全量下载到 Zustand。
- 流程定义列表返回摘要；打开设计器、发布页、详情或历史实例时按需读取完整版本。缓存必须有清晰失效规则，不能成为权限或事实来源。
- 页面写操作统一调用服务端领域命令。Zustand 只保存界面状态和可丢弃查询缓存，不再执行生产业务状态机。
- OpenAPI 生成共享 TypeScript 类型、请求验证器和前端客户端。生成命令必须可重复，生成物与契约差异纳入测试。
- 开工门禁必须实际执行锁定版本的 `@redocly/cli` lint 和 `orval` 生成；生成目标包括共享 TypeScript 类型、Zod 请求校验器和 Axios 客户端。重新生成后工作树存在差异、重复路径/operationId、缺失引用或生成失败时不得进入业务实现或交付。

## 4. SQL Server 部署配置

部署人员只填写以下 SQL Server 环境值；schema、加密、兼容门槛、连接池、超时和死锁重试使用 `apps/api/config/defaults.env` 的安全默认值，需要调整时才在外置 `application.env` 覆盖：

```dotenv
MSSQL_SERVER=<SQL Server 主机或实例地址>
MSSQL_PORT=<TCP端口>
MSSQL_DATABASE=<数据库名>
MSSQL_USER=<应用运行账号>
MSSQL_PASSWORD=<应用运行密码>
MSSQL_EXPECTED_COLLATION=<DBA 确认的数据库排序规则>
```

- 迁移账号不写入常驻应用 Secrets；执行停机迁移时通过单独受限配置或交互式部署环境注入。
- 数据库就绪检查验证服务器版本、兼容级别、预期 schema、迁移校验和和排序规则；SQL Server 2016 13.x 只接受 SP2/SP3，主版本 14 及以上全部接受。`MSSQL_EXPECTED_COMPATIBILITY_LEVEL=130` 表示最低门槛而不是精确值，实际兼容级别 130 及以上均可通过。
- 用户、角色、部门、职务和流程权限组的物理启停列统一为 `is_enabled bit`，API Mapper 统一输出/接收 `enabled | disabled`；流程定义保存 `is_disabled bit` 并结合发布指针推导接口状态，多阶段对象保留 CHECK 约束状态枚举。Migration 和仓储契约测试必须防止这两类状态混用。
- 死锁只对明确可重试且整个事务可安全重放的命令执行指数退避；SMTP、附件写入和其他外部 I/O 不得包含在重试事务中。

### 4.1 当前数据库基础设施实施状态

- `apps/api` 已使用显式 Data Mapper Entity、惰性且可重试的 TypeORM `DataSource` 管理器和事务专属 `QueryRunner` UoW。导入数据库模块不会连接 SQL Server，因此数据库不可用时进程仍可提供存活检查。
- 生产选项固定为 `synchronize=false`、`migrationsRun=false`。首个人工迁移创建 `flowpilot` 身份、组织、角色权限、流程权限组、会话、模拟身份、审计与结构状态基础表；迁移和种子分别通过受控 CLI 执行。
- 首次迁移的 SHA-256 校验和由规范化 schema DDL 集合确定性计算，校验和自身的 ledger/state 写入语句不参与指纹，单元测试独立重算并核对 64 位小写十六进制结果。
- 内置种子在 `SERIALIZABLE` 事务中幂等创建系统部门/职务、初始职务“经理”“员工”、权限目录、超级管理员角色与唯一账号。只有账号尚不存在时才读取 `FLOWPILOT_BOOTSTRAP_ADMIN_PASSWORD` 并生成 scrypt 散列，重复执行不覆盖密码。
- 结构检查与完整就绪检查已分离：迁移 CLI 只校验平台和结构，种子 CLI 写入后再验证当前种子版本、内置权限目录字段、超级管理员角色的完整授权及恰好一条内置超级管理员记录，保证 `db:bootstrap` 可用于已创建的空数据库；目录漂移返回稳定代码 `DATABASE_SEED_CATALOG_MISMATCH`。
- `mssql` 默认 `tedious` 驱动只支持 TCP/IP 连接，不支持 `(localdb)\...` LocalDB 命名管道实例，也不使用 `msnodesqlv8`。检测到 LocalDB 时返回稳定诊断 `UNSUPPORTED_LOCALDB_DRIVER`，不得把它误报为普通账号或密码错误。
- 部署联调仍需提供启用 TCP/IP 和 SQL 账号认证的 SQL Server 主机/端口、数据库名、预期排序规则及分离的迁移/运行账号。当前纯单元测试不替代 SQL Server 2016 SP2、兼容级别 130 最低基线及实际部署更高版本/兼容级别的真实迁移与仓储验收。

## 5. AD/LDAP 配置与行为

```dotenv
DOMAIN_AUTH_URLS=<一个或多个 LDAP/LDAPS 地址，按配置顺序尝试>
DOMAIN_AUTH_BASE_DN=<目录搜索根>
DOMAIN_AUTH_UPN_SUFFIX=<UPN 后缀>
# DOMAIN_AUTH_NETBIOS_NAME=<可选 DOMAIN 名称>
```

域认证启用状态、账号属性、连接/操作超时、503 限流和 TLS 校验使用随代码默认值；只有禁用域认证或接受旧 `ldap://` 明文风险时，才在外置 `application.env` 增加对应覆盖。

- FlowPilot 用户表保存规范化的裸账号。登录输入可以是裸账号、匹配配置后缀的 UPN 或匹配配置名称的 `DOMAIN\user`，服务端统一规范化后查询本地用户。
- 首版默认使用用户 UPN 直接绑定验证密码，再在配置的 Base DN 内同时使用经过 RFC 4515 转义的账号和同一 UPN 筛选器确认唯一用户对象；不要求常驻域服务账号。若公司域策略不允许该方式，再通过配置增加只读搜索账号，不改变业务认证接口。
- FlowPilot 先检查本地用户存在、启用状态和配置的认证模式，再调用域服务；域组不直接映射系统权限，不自动创建用户。
- 错误凭据、域账号禁用、锁定或密码过期统一对客户端返回 `401 INVALID_CREDENTIALS`；连接、证书、DNS 或所有域地址超时返回 `503 DOMAIN_AUTHENTICATION_UNAVAILABLE`。
- 已识别为密码登录的用户只校验本地散列，密码错误或账号停用直接返回 401 并计入凭据失败桶，不调用或探测 LDAP。域登录用户使用 LDAP，未知账号可使用匿名 RootDSE 探测统一域侧 401/503 响应；探测和域故障使用 5 秒共享缓存与并发合并。503 使用独立的客户端 IP 速率桶，不能计入账号密码失败桶。
- LDAP 查询必须参数化或转义，密码不得进入日志、指标、审计、异常消息或健康详情。
- 默认只允许 LDAPS。只有旧域端点确实无法提供 TLS 时，部署方才可设置 `DOMAIN_AUTH_ALLOW_PLAINTEXT=true`，并在验收中记录域密码会以明文跨网络传输的风险；不能仅通过填写 `ldap://` 静默降级。

## 6. 本地密码、会话和请求安全

- 本地密码使用 Node.js 内置异步 `crypto.scrypt()`，不安装 Argon2/bcrypt 原生模块。基线参数为 `N=65536`、`r=8`、`p=1`、`maxmem=96 MiB`、16 字节随机盐和 32 字节派生密钥；算法、格式版本和完整参数随散列编码保存，比较使用 `timingSafeEqual`。目标服务器实测后可以提高参数，已有较低参数在成功登录后渐进重哈希。
- 登录限流默认按“规范账号 + 客户端 IP”15 分钟最多 5 次失败，并按客户端 IP 15 分钟最多 100 次失败；封禁 15 分钟，参数可配置。成功登录只清除账号维度计数，不绕过 IP 总量限制。
- 仅信任从本机 IIS/ARR 反向代理到 `127.0.0.1` 的转发头。IIS 必须覆盖并丢弃外部请求已有的 `X-Forwarded-For`、`X-Forwarded-Host` 和 `X-Forwarded-Proto`，分别写入真实客户端地址、当前已匹配站点绑定的主机和协议；不得透传、拼接或信任客户端提供的值。IIS 同时限制实际内外网站点绑定，并在反代前拒绝未知 `Host`。
- Cookie 名称 `flowpilot_session`，`Path=/api/flowpilot`，`HttpOnly`、`SameSite=Strict`；当前 HTTP 部署 `Secure=false`，启用 HTTPS 后必须配置为 `true`。
- 登录、权限变更、密码重置、认证方式切换和开始/结束模拟身份后轮换会话令牌。闲置期在安全阈值内滑动续期，绝对 24 小时有效期不延长。
- 所有修改请求优先校验 `Origin`；只有该头缺失时才使用 `Referer`，并将来源 origin 与可信代理后的 protocol 和 host 精确比较。两者缺失、格式非法或不匹配时返回 `403 CSRF_VALIDATION_FAILED`；通过后把 `${origin}/flowpilot` 冻结到请求上下文。
- 请求头、JSON、查询字符串、multipart 字段数量和富文本长度都设置服务器端上限；超限在进入领域事务前拒绝。

## 7. 附件实现参数

- 系统默认单文件 100 MiB、单附件控件 20 个文件、附件卷至少保留 2 GiB；流程字段只能进一步收紧，不能突破系统上限。
- 使用固定版本的 `file-type` 做常见格式魔数识别，并对 PDF、ZIP 容器、Office Open XML 增加专门检查。扩展名、声明 MIME 和识别内容不一致时默认拒绝，不能只信任浏览器声明。
- 继续禁止可执行和脚本扩展名；同时识别 PE、脚本 shebang、Windows 快捷方式等危险签名。双扩展名按最后扩展名和完整名称共同检查。
- `{ID分片}` 固定使用附件 UUID 去除连字符后的前四个十六进制字符，分为两级目录，例如 `ab/cd/{attachmentId}`，避免单目录文件过多。
- multipart 流式写入同卷 `.incoming`；请求取消、校验失败和进程恢复后都由幂等清理任务处理残留 `.part`。
- 富文本图片和媒体也使用通用附件上传，`purpose=free-reply` 或对应业务用途，并在保存正文的事务中建立引用；HTML 中不得保存可直接绕过鉴权的物理路径。
- 首版不做病毒扫描已作为明确风险接受项。服务端仍执行黑名单、内容签名、大小、数量、HTML 清理和下载鉴权；后续接入杀毒引擎时扩展附件状态机。

## 8. SMTP、后台任务和运维

```dotenv
SMTP_HOST=<SMTP 主机>
SMTP_USER=<可选认证账号>
SMTP_PASSWORD=<可选认证密码>
SMTP_FROM=<发件地址>
# SMTP_TLS_SERVERNAME=<使用 IP 连接且启用 TLS 时的可选证书主机名>
# SMTP_REPLY_TO=<可选回复地址>
```

SMTP 端口、TLS、证书校验、超时和连接池使用随代码安全默认值；只有禁用 SMTP、改用隐式 TLS 端口，或接受旧明文 SMTP 风险时，才在外置 `application.env` 增加对应覆盖。

- `SMTP_SECURE=true` 表示连接建立时即使用 TLS；端口 25/587 通常使用 `SMTP_SECURE=false`、`SMTP_REQUIRE_TLS=true` 强制 STARTTLS，不能使用会在降级后继续明文投递的机会式模式。只有部署方明确接受内网明文传输风险时才同时设置 `SMTP_REQUIRE_TLS=false`、`SMTP_IGNORE_TLS=true`。使用 IP 地址连接且校验证书时配置 `SMTP_TLS_SERVERNAME`。
- 新后端不得创建或调用 `CDO.Message`、`sp_OACreate`、`sp_OASetProperty` 或其他 SQL Server OLE Automation 发信过程；固定发件人和 SMTP 凭据只进入 Nodemailer 网关，业务事务只写 Outbox。
- 站点根地址不进入环境文件。触发邮件事件的浏览器写请求必须把 `Origin`（缺失时才用 `Referer`）与可信代理后的 protocol/host 精确比较，并把自动得到的 `${origin}/flowpilot` 随 Outbox 冻结；无请求事件只继承实例已保存的验证入口，没有可继承值时明确失败并进入死信。邮件只允许拼接服务端生成的 `/processes/{instanceId}` 相对路径和可选 `taskId`，禁止接受用户输入的跳转地址或根据 loopback、服务器名、任意 `Host`、未经校验的转发头猜测目标主机。
- 未登录用户点击邮件后先登录；前端只保存经过同源和 FlowPilot 基路径校验的返回地址，登录完成后返回流程详情。`taskId` 只用于定位任务，不是授权凭证，详情读取和处理命令仍由后端鉴权。
- Outbox 和 `email_delivery_attempts` 均写入 SQL Server；运维列表可以查看收件人邮箱快照、主题、目标链接、状态、尝试次数、时间和脱敏错误，但不显示或保存完整邮件正文和 SMTP 凭据。
- 邮件、附件清理、过期会话、幂等清理均使用数据库租约。默认每分钟扫描一次，每批最多 50 条，租约 5 分钟；附件大批量清理单独限制并发，避免占满磁盘 I/O。
- 邮件发送并发默认 5，单次 SMTP 超时默认 15 秒；失败仍按 1、5、15、60、360 分钟重试，累计 6 次进入死信。
- 技术日志以 JSON Lines 输出，包含 UTC 时间、level、traceId、事件名和经过脱敏的上下文。WinSW 按日期和大小滚动，应用保留 30 天。
- 服务器必须启用可靠时间同步。编号年份月份、附件年份和邮件显示使用 `Asia/Shanghai`，数据库比较、租约和审计使用 UTC。
- 投影校验/重建、附件清单、附件完整性检查、数据库迁移、种子校验和超级管理员离线重置使用停机或受控 CLI。REST 只提供只读状态和健康详情，不直接暴露任意重建或删除命令。

## 9. 测试和交付门禁

- 在真实 SQL Server 2016 SP2、兼容级别 130 的最低基线和实际部署的更高版本/兼容级别环境执行仓储集成、Migration、死锁/并发和 JSON/投影测试；不能只用 Mock 或内存数据库代替。
- 对空数据库和上一结构版本分别执行迁移，并验证校验和不一致、结构落后和兼容级别错误时服务拒绝就绪。
- AD 和 SMTP 使用可控测试替身覆盖失败映射，并在部署环境各完成一次真实域登录和测试邮件。
- 附件测试覆盖中断、超限、危险签名、路径穿越、Range、磁盘不足、业务事务失败、替换、重复清理和越权下载。
- OpenAPI 生成、请求/响应校验、Problem Details、ETag、If-Match、幂等重放和 Cookie 会话必须有契约测试。
- 用户、角色、部门/职务和流程权限组删除测试必须覆盖独立动作权限、内置项、当前账号、无引用成功、各类可变与历史引用冲突、过期 ETag、会话撤销、审计保留及并发新增引用时的事务竞态；仅有编辑权限时删除接口必须返回 403。
- IIS 验收覆盖静态路由、Cookie、反向代理头、上传大小、Range、健康检查、服务重启和旧版本回滚。客户端 IP 验收必须从两个不同来源执行受控失败登录，确认限流桶不会串用；还要伪造 `X-Forwarded-For`、`X-Forwarded-Host` 和 `X-Forwarded-Proto`，确认 IIS 全部覆盖，伪造值不能绕过限流/同源校验或改变冻结的邮件入口，并确认未知 Host 在反代前被拒绝。

## 10. 部署人员后续填写项

以下内容在后端完成并准备部署时填写，不阻塞当前文档和代码结构设计：

- 实际程序目录和 Windows 服务账号。
- SQL Server 主机、数据库、应用账号、迁移账号和排序规则。
- LDAP/LDAPS 地址、Base DN、UPN 后缀、NetBIOS 名称和证书信任方式。
- SMTP 地址、认证信息与发件人。
- 首次初始化超级管理员密码。
- IIS 主机名、端口、应用路径和以后启用 HTTPS 时的证书。

所有真实值只写入服务器外置 `Config\application.env` 或 `Secrets\production.env`，不得写入仓库、程序发布包、截图、测试快照或日志。
