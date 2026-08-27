SET NOCOUNT ON;

DECLARE @changed int = 0;

DECLARE @expected_positions table
(
    [id] uniqueidentifier NOT NULL PRIMARY KEY,
    [code] nvarchar(100) NOT NULL,
    [name] nvarchar(200) NOT NULL,
    [sort_order] int NOT NULL,
    [description] nvarchar(1000) NOT NULL,
    UNIQUE ([code]),
    UNIQUE ([name])
);

INSERT INTO @expected_positions ([id], [code], [name], [sort_order], [description])
VALUES
    (@manager_position_id, @manager_position_code, @manager_position_name, 10, N'系统初始职务'),
    (@employee_position_id, @employee_position_code, @employee_position_name, 20, N'系统初始职务');

IF EXISTS
(
    SELECT 1
    FROM [flowpilot].[positions] AS [position] WITH (UPDLOCK, HOLDLOCK)
    INNER JOIN @expected_positions AS [expected]
        ON [position].[normalized_code] = [expected].[code]
        OR [position].[normalized_name] = [expected].[name]
    WHERE [position].[id] <> [expected].[id]
)
    THROW 51111, 'Built-in position conflicts with an existing row.', 1;

UPDATE [position]
SET [code] = [expected].[code],
    [normalized_code] = [expected].[code],
    [name] = [expected].[name],
    [normalized_name] = [expected].[name],
    [sort_order] = [expected].[sort_order],
    [is_enabled] = 1,
    [description] = [expected].[description],
    [revision] = [position].[revision] + 1,
    [updated_at] = @now
FROM [flowpilot].[positions] AS [position]
INNER JOIN @expected_positions AS [expected] ON [expected].[id] = [position].[id]
WHERE [position].[code] <> [expected].[code]
   OR [position].[normalized_code] <> [expected].[code]
   OR [position].[name] <> [expected].[name]
   OR [position].[normalized_name] <> [expected].[name]
   OR [position].[sort_order] <> [expected].[sort_order]
   OR [position].[is_enabled] <> 1
   OR ISNULL([position].[description], N'') <> [expected].[description];
SET @changed += @@ROWCOUNT;

INSERT INTO [flowpilot].[positions]
(
    [id], [code], [normalized_code], [name], [normalized_name], [sort_order],
    [is_enabled], [description], [revision], [created_at], [updated_at],
    [created_by], [updated_by]
)
SELECT
    [expected].[id], [expected].[code], [expected].[code], [expected].[name], [expected].[name],
    [expected].[sort_order], 1, [expected].[description], 1, @now, @now, NULL, NULL
FROM @expected_positions AS [expected]
WHERE NOT EXISTS
(
    SELECT 1 FROM [flowpilot].[positions] WITH (UPDLOCK, HOLDLOCK)
    WHERE [id] = [expected].[id]
);
SET @changed += @@ROWCOUNT;

IF EXISTS
(
    SELECT 1 FROM [flowpilot].[users] WITH (UPDLOCK, HOLDLOCK)
    WHERE ([is_builtin_super_admin] = 1 OR [normalized_login_name] = @super_admin_normalized_login_name)
      AND [id] <> @super_admin_user_id
)
OR EXISTS
(
    SELECT 1 FROM [flowpilot].[users] WITH (UPDLOCK, HOLDLOCK)
    WHERE [id] = @super_admin_user_id AND [is_builtin_super_admin] = 0
)
    THROW 51112, 'Built-in super administrator conflicts with an existing row.', 1;

UPDATE [flowpilot].[users]
SET [login_name] = @super_admin_login_name,
    [normalized_login_name] = @super_admin_normalized_login_name,
    [display_name] = @super_admin_display_name,
    [email] = @super_admin_email,
    [authentication_mode] = N'password',
    [department_id] = NULL,
    [position_id] = NULL,
    [is_enabled] = 1,
    [is_builtin_super_admin] = 1,
    [revision] = [revision] + 1,
    [updated_at] = @now,
    [updated_by] = @super_admin_user_id
WHERE [id] = @super_admin_user_id
  AND
  (
      [login_name] <> @super_admin_login_name
      OR [normalized_login_name] <> @super_admin_normalized_login_name
      OR [display_name] <> @super_admin_display_name OR [email] <> @super_admin_email
      OR [authentication_mode] <> N'password' OR [department_id] IS NOT NULL
      OR [position_id] IS NOT NULL OR [is_enabled] <> 1
      OR [is_builtin_super_admin] <> 1
  );
SET @changed += @@ROWCOUNT;

IF NOT EXISTS
(
    SELECT 1 FROM [flowpilot].[users] WITH (UPDLOCK, HOLDLOCK)
    WHERE [id] = @super_admin_user_id
)
BEGIN
    IF @super_admin_password_hash IS NULL
        THROW 51113, 'Initial super administrator password is required.', 1;

    INSERT INTO [flowpilot].[users]
    (
        [id], [login_name], [normalized_login_name], [display_name], [email],
        [authentication_mode], [password_hash], [department_id], [position_id],
        [is_enabled], [is_builtin_super_admin], [revision], [created_at], [updated_at],
        [created_by], [updated_by]
    )
    VALUES
    (
        @super_admin_user_id, @super_admin_login_name, @super_admin_normalized_login_name,
        @super_admin_display_name, @super_admin_email, N'password', @super_admin_password_hash,
        NULL, NULL, 1, 1, 1, @now, @now, NULL, NULL
    );
    SET @changed += 1;
END;

IF EXISTS
(
    SELECT 1 FROM [flowpilot].[roles] WITH (UPDLOCK, HOLDLOCK)
    WHERE ([normalized_code] = @super_admin_role_normalized_code
        OR [normalized_name] = @super_admin_role_normalized_name)
      AND [id] <> @super_admin_role_id
)
OR EXISTS
(
    SELECT 1 FROM [flowpilot].[roles] WITH (UPDLOCK, HOLDLOCK)
    WHERE [id] = @super_admin_role_id AND [is_builtin] = 0
)
    THROW 51114, 'Built-in super administrator role conflicts with an existing row.', 1;

UPDATE [flowpilot].[roles]
SET [code] = @super_admin_role_code,
    [normalized_code] = @super_admin_role_normalized_code,
    [name] = @super_admin_role_name,
    [normalized_name] = @super_admin_role_normalized_name,
    [description] = N'系统内置最高权限角色',
    [is_enabled] = 1,
    [is_builtin] = 1,
    [revision] = [revision] + 1,
    [updated_at] = @now,
    [updated_by] = @super_admin_user_id
WHERE [id] = @super_admin_role_id
  AND
  (
      [code] <> @super_admin_role_code OR [normalized_code] <> @super_admin_role_normalized_code
      OR [name] <> @super_admin_role_name OR [normalized_name] <> @super_admin_role_normalized_name
      OR ISNULL([description], N'') <> N'系统内置最高权限角色'
      OR [is_enabled] <> 1 OR [is_builtin] <> 1
  );
SET @changed += @@ROWCOUNT;

IF NOT EXISTS
(
    SELECT 1 FROM [flowpilot].[roles] WITH (UPDLOCK, HOLDLOCK)
    WHERE [id] = @super_admin_role_id
)
BEGIN
    INSERT INTO [flowpilot].[roles]
    (
        [id], [code], [normalized_code], [name], [normalized_name], [description],
        [is_enabled], [is_builtin], [revision], [created_at], [updated_at],
        [created_by], [updated_by]
    )
    VALUES
    (
        @super_admin_role_id, @super_admin_role_code, @super_admin_role_normalized_code,
        @super_admin_role_name, @super_admin_role_normalized_name, N'系统内置最高权限角色',
        1, 1, 1, @now, @now, @super_admin_user_id, @super_admin_user_id
    );
    SET @changed += 1;
END;

DECLARE @expected_permissions table
(
    [code] nvarchar(150) NOT NULL PRIMARY KEY,
    [resource] nvarchar(100) NOT NULL,
    [action] nvarchar(100) NOT NULL,
    [name] nvarchar(200) NOT NULL,
    [sort_order] int NOT NULL,
    UNIQUE ([resource], [action])
);

INSERT INTO @expected_permissions ([code], [resource], [action], [name], [sort_order])
SELECT [code], [resource], [action], [name], [sort_order]
FROM OPENJSON(@permissions_json)
WITH
(
    [code] nvarchar(150) '$.Code',
    [resource] nvarchar(100) '$.Resource',
    [action] nvarchar(100) '$.Action',
    [name] nvarchar(200) '$.Name',
    [sort_order] int '$.SortOrder'
);

IF (SELECT COUNT(*) FROM @expected_permissions) <> @permission_count
    THROW 51115, 'The built-in permission catalog is invalid.', 1;

IF EXISTS
(
    SELECT 1
    FROM [flowpilot].[permissions] AS [permission] WITH (UPDLOCK, HOLDLOCK)
    INNER JOIN @expected_permissions AS [expected] ON [expected].[code] = [permission].[code]
    WHERE [permission].[is_builtin] = 0
)
OR EXISTS
(
    SELECT 1
    FROM [flowpilot].[permissions] AS [permission] WITH (UPDLOCK, HOLDLOCK)
    INNER JOIN @expected_permissions AS [expected]
        ON [expected].[resource] = [permission].[resource]
        AND [expected].[action] = [permission].[action]
    WHERE [permission].[code] <> [expected].[code]
)
    THROW 51116, 'Built-in permissions conflict with existing rows.', 1;

UPDATE [permission]
SET [resource] = [expected].[resource],
    [action] = [expected].[action],
    [name] = [expected].[name],
    [sort_order] = [expected].[sort_order],
    [is_builtin] = 1,
    [updated_at] = @now
FROM [flowpilot].[permissions] AS [permission]
INNER JOIN @expected_permissions AS [expected] ON [expected].[code] = [permission].[code]
WHERE [permission].[resource] <> [expected].[resource]
   OR [permission].[action] <> [expected].[action]
   OR [permission].[name] <> [expected].[name]
   OR [permission].[sort_order] <> [expected].[sort_order]
   OR [permission].[is_builtin] <> 1;
SET @changed += @@ROWCOUNT;

INSERT INTO [flowpilot].[permissions]
    ([code], [resource], [action], [name], [sort_order], [is_builtin], [created_at], [updated_at])
SELECT
    [expected].[code], [expected].[resource], [expected].[action], [expected].[name],
    [expected].[sort_order], 1, @now, @now
FROM @expected_permissions AS [expected]
WHERE NOT EXISTS
(
    SELECT 1 FROM [flowpilot].[permissions] WITH (UPDLOCK, HOLDLOCK)
    WHERE [code] = [expected].[code]
);
SET @changed += @@ROWCOUNT;

DELETE [role_permission]
FROM [flowpilot].[role_permissions] AS [role_permission]
INNER JOIN [flowpilot].[permissions] AS [permission]
    ON [permission].[code] = [role_permission].[permission_code]
LEFT JOIN @expected_permissions AS [expected] ON [expected].[code] = [permission].[code]
WHERE [permission].[is_builtin] = 1 AND [expected].[code] IS NULL;
SET @changed += @@ROWCOUNT;

DELETE [permission]
FROM [flowpilot].[permissions] AS [permission]
LEFT JOIN @expected_permissions AS [expected] ON [expected].[code] = [permission].[code]
WHERE [permission].[is_builtin] = 1 AND [expected].[code] IS NULL;
SET @changed += @@ROWCOUNT;

IF EXISTS
(
    SELECT 1 FROM [flowpilot].[user_roles] WITH (UPDLOCK, HOLDLOCK)
    WHERE ([role_id] = @super_admin_role_id AND [user_id] <> @super_admin_user_id)
       OR ([user_id] = @super_admin_user_id AND [role_id] <> @super_admin_role_id)
)
    THROW 51117, 'The built-in super administrator role membership is inconsistent.', 1;

IF NOT EXISTS
(
    SELECT 1 FROM [flowpilot].[user_roles] WITH (UPDLOCK, HOLDLOCK)
    WHERE [user_id] = @super_admin_user_id AND [role_id] = @super_admin_role_id
)
BEGIN
    INSERT INTO [flowpilot].[user_roles] ([user_id], [role_id], [granted_by], [granted_at])
    VALUES (@super_admin_user_id, @super_admin_role_id, @super_admin_user_id, @now);
    SET @changed += 1;
END;

DELETE [role_permission]
FROM [flowpilot].[role_permissions] AS [role_permission]
LEFT JOIN @expected_permissions AS [expected]
    ON [expected].[code] = [role_permission].[permission_code]
WHERE [role_permission].[role_id] = @super_admin_role_id AND [expected].[code] IS NULL;
SET @changed += @@ROWCOUNT;

INSERT INTO [flowpilot].[role_permissions]
    ([role_id], [permission_code], [granted_by], [granted_at])
SELECT @super_admin_role_id, [expected].[code], @super_admin_user_id, @now
FROM @expected_permissions AS [expected]
WHERE NOT EXISTS
(
    SELECT 1 FROM [flowpilot].[role_permissions] WITH (UPDLOCK, HOLDLOCK)
    WHERE [role_id] = @super_admin_role_id AND [permission_code] = [expected].[code]
);
SET @changed += @@ROWCOUNT;

UPDATE [flowpilot].[system_state]
SET [state_value] = @seed_version,
    [revision] = [revision] + 1,
    [updated_at] = @now,
    [updated_by] = @super_admin_user_id
WHERE [state_key] = N'builtin-seed' AND [state_value] <> @seed_version;
SET @changed += @@ROWCOUNT;

IF NOT EXISTS
(
    SELECT 1 FROM [flowpilot].[system_state] WITH (UPDLOCK, HOLDLOCK)
    WHERE [state_key] = N'builtin-seed'
)
BEGIN
    INSERT INTO [flowpilot].[system_state]
        ([state_key], [state_value], [revision], [updated_at], [updated_by])
    VALUES (N'builtin-seed', @seed_version, 1, @now, @super_admin_user_id);
    SET @changed += 1;
END;

SELECT @changed;
