# FlowPilot API

后端使用 NestJS、TypeORM 0.3、`mssql` 默认 `tedious` 驱动和 SQL Server。业务表显式位于 `flowpilot` schema；生产配置固定关闭 `synchronize` 与 `migrationsRun`，服务启动不会自动连接或修改数据库。

## 数据库初始化

稳定且非敏感的默认值随后端保存在 [`config/defaults.env`](./config/defaults.env)，部署时不需要复制或逐项填写。先从精简模板创建仓库外的 `{FLOWPILOT_HOME}\Config\application.env` 与 `{FLOWPILOT_HOME}\Secrets\production.env`：前者只填写应用公开地址、数据库排序规则和确有必要的安全默认覆盖，后者只填写 SQL Server、LDAP、SMTP 的环境地址与凭据。`FLOWPILOT_PUBLIC_BASE_URLS` 可用分号配置多个内外网入口，全部入口均允许同源写操作。后端把写请求的 `Origin/Referer` 精确映射到配置项，邮件随 Outbox 冻结该入口；无浏览器请求的系统任务才使用第一项。所有入口必须统一使用 HTTP 或 HTTPS，不能根据 `Host` 或未经校验的转发头推导。本地源码运行时应显式把 `FLOWPILOT_HOME` 指向此外置根目录；也可以用 `FLOWPILOT_CONFIG_FILE`、`FLOWPILOT_SECRETS_FILE` 分别指定两个文件的绝对路径。读取优先级为进程环境变量、`production.env`、`application.env`、随代码 `defaults.env`。首次初始化必须临时提供 `FLOWPILOT_BOOTSTRAP_ADMIN_PASSWORD`，该值不会写入仓库或日志，已有超级管理员的密码不会在重复初始化时被覆盖。

初始化命令不会创建数据库。DBA 必须先创建目标数据库、设置不低于 130 的兼容级别与部署确认的排序规则。服务器最低为 SQL Server 2016 13.x SP2：13.x 接受 SP2/SP3，主版本 14 及以上正常通过且不检查 `ProductLevel`。`MSSQL_EXPECTED_COMPATIBILITY_LEVEL=130` 保留为配置键，但表示最低门槛，实际兼容级别可以是 130/140/150/160 或更高值。停机迁移账号和常驻运行账号应分离，运行账号只授予 `flowpilot` schema 所需权限，不得使用 `sysadmin`。

SQL Server 模板默认 `MSSQL_ENCRYPT=true`、`MSSQL_TRUST_SERVER_CERTIFICATE=false`，远程主机应配置可验证的服务器证书。只有 API 与 SQL Server 确认运行在同一台机器并通过 `127.0.0.1` 回环连接时，才可在记录风险后显式改为未加密/信任服务器证书；该例外不得复制到远程数据库配置。

```powershell
pnpm --filter @process-site/api db:migrate
pnpm --filter @process-site/api db:seed
```

也可以运行 `pnpm --filter @process-site/api db:bootstrap` 顺序执行两步。迁移命令只校验数据库平台与结构；种子命令先校验结构、在 `SERIALIZABLE` 事务中写入内置目录，再执行包含唯一超级管理员和种子版本的完整就绪检查。

当前驱动要求启用 TCP/IP 并使用 SQL 账号认证，不支持 `(localdb)\...` LocalDB。检测到 LocalDB 时命令和就绪检查返回稳定代码 `UNSUPPORTED_LOCALDB_DRIVER`；项目不安装或回退到 `msnodesqlv8`。

数据库单元测试不连接真实服务。发布验收仍须按数据库结构文档在 SQL Server 2016 SP2、兼容级别 130 的最低基线和实际部署的更高版本/兼容级别环境执行迁移、仓储和并发集成测试。

## AD/LDAP 登录

域用户必须先存在于 FlowPilot 用户表且处于启用状态。登录时服务端接受裸账号、匹配配置的 UPN 或 `NETBIOS\账号`，统一转换为裸账号后读取本地用户；只有该用户的登录方式为 `domain` 才调用 LDAP。提供方使用本次请求中的用户 UPN 和密码直接 bind，再在配置的 Base DN 子树中用经过 RFC 4515 转义的 `sAMAccountName` 与同一 `userPrincipalName` 共同确认唯一用户，随后立即 unbind，避免“绑定身份”和“搜索身份”错配。域密码不写入数据库、会话、日志或健康详情，域失败也不会回退到本地密码；内置超级管理员继续使用本地 scrypt 密码，因此不依赖域服务。

`DOMAIN_AUTH_URLS` 可用分号或逗号配置多个 `ldap://`/`ldaps://` 地址并按顺序容错。部署值只填写在仓库外的 `Secrets\production.env`，键名见 [`config/production.env.example`](./config/production.env.example)。默认只允许 LDAPS；旧域端点确实无法提供 TLS 时，必须在外置 `application.env` 显式设置 `DOMAIN_AUTH_ALLOW_PLAINTEXT=true` 并记录域密码明文传输风险，不能修改随代码默认文件或仅填写 `ldap://` 静默降级。受保护的详细健康接口执行匿名 RootDSE 探测；只有搜索成功才显示正常，探测结果与域基础设施故障使用 5 秒共享缓存并合并并发请求，不保存或使用服务账号密码。

为避免域故障暴露本地账号是否存在、是否停用或采用哪种认证方式，所有不能确认 LDAP 可达的失败登录统一返回 `503 DOMAIN_AUTHENTICATION_UNAVAILABLE`；只有已确认 LDAP 可达时才把错误凭据计入账号/IP 的 401 失败桶。503 另按客户端 IP 限制，默认每分钟 60 次并封禁一分钟，部署时应结合内网 NAT 规模调整 `AUTH_LOGIN_UNAVAILABLE_*` 参数。

`production.env` 由 dotenv 语法解析。密码或其他秘密中只要可能包含 `#`、空格或前后空白，就必须使用单引号包裹；若秘密本身包含单引号，则改用双引号并按 dotenv 规则转义。仓库模板已对三个密码占位项加引号，填写时保留引号但不得把真实值提交到 Git。

## SMTP 网关

邮件基础设施直接使用 Nodemailer 连接 SMTP，支持 To、Bcc、最多 400 字符主题以及 Text/HTML 正文。发件地址固定来自外置配置，调用方不能覆盖；收件人与回复地址只接受纯邮箱地址，并拒绝换行和显示名称形式。连接池最多并发 5 条连接，连接、问候和 Socket 超时均可配置，`verify()` 只验证 DNS/TCP/TLS/认证而不发送邮件。

SMTP 默认强制 STARTTLS；旧内网服务器确实不支持 TLS 时，必须显式设置 `SMTP_REQUIRE_TLS=false` 与 `SMTP_IGNORE_TLS=true`，并记录邮件凭据和正文使用明文链路的风险接受，不能使用可静默降级的机会式配置。

旧系统的 `CDO.Message`、`sp_OACreate`/`sp_OASetProperty` 存储过程不会迁移，也不需要启用 SQL Server OLE Automation。当前切片只提供安全 SMTP 网关和健康检查，没有公开“直接发信”REST API；流程事务后续只写 SQL Server Outbox，再由带数据库租约、重试和死信记录的 worker 调用该网关。SMTP 主机、账号、密码、固定发件地址及 TLS 证书主机名只放在仓库外的 `Secrets\production.env`；TLS、超时和并发采用随代码安全默认值，只有确需覆盖时才在外置 `Config\application.env` 增加对应键。
