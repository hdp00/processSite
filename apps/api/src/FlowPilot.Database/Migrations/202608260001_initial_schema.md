# 202608260001 initial schema

`202608260001_initial_schema.sql` is the complete structural baseline for
`BACKEND_DATABASE_SCHEMA.md` sections 2 through 6. It creates the `flowpilot`
schema, the migration ledger, all confirmed base tables, named constraints,
foreign keys, filtered/unique indexes, query indexes, and the database triggers
for invariants that cannot be represented by row-level CHECK constraints. They
cover department-cycle rejection, task/instance assignee consistency,
reply-edit target validation, append-only workflow/audit events, and built-in
super-administrator protection.

`InitialSchemaEfMigration.cs` wraps the same embedded SQL and records the same
computed checksum for EF Core's model-evolution path. The controlled local
runner and the reviewed DBA SQL remain the normal execution paths; the resident
API never calls EF migration APIs.

It intentionally does not create database users, logins, demo data, built-in
directory data, or the first super administrator. The separately controlled
seed command owns those writes and must run after this migration.

## Runner contract

The runner must execute the SQL resource as one `SqlCommand`; the file contains
no `GO` separators. The complete protocol is:

1. Validate SQL Server 13.x SP2/SP3 or major version 14+, compatibility level
   130+, and the configured database collation.
2. Begin a transaction with `XACT_ABORT` enabled and acquire an exclusive,
   transaction-owned application lock for FlowPilot schema migration.
3. If `flowpilot.schema_migrations` already contains migration
   `202608260001` with result `succeeded` and the expected checksum, commit a
   no-op without executing the resource. Reject a different checksum, an
   incomplete ledger row, or schema objects without a matching ledger result.
4. Execute the entire SQL resource. It creates both the schema and ledger as
   part of the same transaction and deliberately fails if `flowpilot` already
   exists at this point.
5. Insert the ledger row in the same transaction only after the resource
   succeeds. Use migration ID `202608260001`, a stable name such as
   `initial_schema`, the runner-computed lowercase SHA-256, UTC
   `datetime2(3)` start/completion values, the runner version, and result
   `succeeded`.
6. Commit. On any exception, roll back the complete transaction and preserve
   the external deployment diagnostic without logging credentials or the
   connection string.

The checksum is calculated from the normalized SQL schema resource. The ledger
INSERT and any later `system_state` seed writes are excluded so the checksum
does not contain a self-reference. Normalization must have a single tested
implementation with stable UTF-8/LF encoding and no BOM.

## Permission boundary

- A controlled migration account executes this resource and owns the required
  DDL permission, including permission to create the schema with `dbo` as its
  owner. Its credentials never enter the resident API configuration.
- The resident application account receives only the table DML and stored
  procedure execution permissions required by implemented features.
- The resident account receives SELECT, but never INSERT/UPDATE/DELETE, on
  `flowpilot.schema_migrations` and `flowpilot.system_state`. It also needs
  schema-scoped `VIEW DEFINITION` on `flowpilot` so readiness can compare the
  versioned table/column/constraint/index/trigger signatures, but receives no
  ALTER, CONTROL, CREATE, DROP, `db_owner`, or `db_ddladmin` membership.
- Database principal creation and environment-specific grants remain DBA
  deployment steps and are intentionally absent from the portable schema DDL.

## SQL Server 2016 notes

- All times use `datetime2(3)`, JSON uses `nvarchar(max)` plus `ISJSON`, and no
  SQL Server 2017+ syntax is used.
- `instance_field_values.text_value` is `nvarchar(2000)`, which is wider than a
  SQL Server 2016 nonclustered index key. Exact text lookup therefore uses the
  application-supplied SHA-256 `text_value_hash` as the key and includes the
  original value for collision verification; the application must compare both
  hash and full text.
- Only aggregate-owned association/projection rows use `ON DELETE CASCADE`.
  Historical facts and references to users, definitions, versions, instances,
  tasks, attachments, and audit actors use `NO ACTION`.
- SQL Server cannot express the rule that a permission group has at least one
  purpose as a row-level constraint. The group aggregate write must create or
  update the group and its non-empty purpose set in one transaction.
- Form fields and free-collaboration replies accept attachment arrays, so their
  lookup indexes are intentionally non-unique. Each attachment can have only
  one active business reference, enforced by the unique `attachment_id` index;
  replacement creates a new attachment/reference and moves the old attachment
  through the cleanup state machine.

## Acceptance

Run against an empty dedicated database on SQL Server 2016 SP2 with
compatibility level 130 and again on the actual deployment server version.
Verify every named table, column, constraint, foreign key, trigger, and index;
exercise JSON, enum, revision, projection-value, attachment-path, session,
idempotency, task-shape, filtered uniqueness, department-cycle, and protected
super-administrator failures.

Running the migration package a second time with the same ID/checksum must be a
runner-level no-op. A changed checksum, partial schema, missing ledger row, or
incomplete result must fail closed. Injected DDL failure must leave neither the
schema nor ledger behind after rollback. After structural migration but before
the separate seed command completes, full application readiness must remain
unavailable.
