ALTER TABLE [flowpilot].[users] DROP CONSTRAINT [fk_users_department];
ALTER TABLE [flowpilot].[users] DROP CONSTRAINT [fk_users_position];
ALTER TABLE [flowpilot].[users] DROP CONSTRAINT [ck_users_email];
ALTER TABLE [flowpilot].[users] DROP CONSTRAINT [ck_users_builtin_super_admin];

ALTER TABLE [flowpilot].[users] ALTER COLUMN [department_id] uniqueidentifier NULL;
ALTER TABLE [flowpilot].[users] ALTER COLUMN [position_id] uniqueidentifier NULL;

UPDATE [flowpilot].[users]
SET [email] = N'',
    [department_id] = NULL,
    [position_id] = NULL,
    [revision] = [revision] + 1,
    [updated_at] = SYSUTCDATETIME()
WHERE [is_builtin_super_admin] = 1
  AND ([email] <> N'' OR [department_id] IS NOT NULL OR [position_id] IS NOT NULL);

UPDATE [flowpilot].[users]
SET [department_id] = NULL,
    [revision] = [revision] + 1,
    [updated_at] = SYSUTCDATETIME()
WHERE [department_id] = 'f6a9320c-68c7-4f74-8ab0-f85e1dc564a2';

UPDATE [flowpilot].[users]
SET [position_id] = NULL,
    [revision] = [revision] + 1,
    [updated_at] = SYSUTCDATETIME()
WHERE [position_id] = '65a87fa5-f816-4475-88f3-857f3da4eb88';

IF EXISTS
(
    SELECT 1 FROM [flowpilot].[departments]
    WHERE [id] = 'f6a9320c-68c7-4f74-8ab0-f85e1dc564a2' AND [normalized_code] <> N'system'
)
    THROW 51120, 'The former system department id is used by another department.', 1;

IF EXISTS
(
    SELECT 1 FROM [flowpilot].[positions]
    WHERE [id] = '65a87fa5-f816-4475-88f3-857f3da4eb88' AND [normalized_code] <> N'system'
)
    THROW 51121, 'The former system position id is used by another position.', 1;

DELETE FROM [flowpilot].[departments]
WHERE [id] = 'f6a9320c-68c7-4f74-8ab0-f85e1dc564a2';

DELETE FROM [flowpilot].[positions]
WHERE [id] = '65a87fa5-f816-4475-88f3-857f3da4eb88';

ALTER TABLE [flowpilot].[users]
    ADD CONSTRAINT [ck_users_email] CHECK
    (
        ([is_builtin_super_admin] = 1 AND [email] = N'')
        OR ([is_builtin_super_admin] = 0 AND LEN(LTRIM(RTRIM([email]))) > 0)
    );

ALTER TABLE [flowpilot].[users]
    ADD CONSTRAINT [ck_users_builtin_super_admin] CHECK
    (
        [is_builtin_super_admin] = 0
        OR
        (
            [authentication_mode] = N'password'
            AND [is_enabled] = 1
            AND [email] = N''
            AND [department_id] IS NULL
            AND [position_id] IS NULL
        )
    );

ALTER TABLE [flowpilot].[users]
    ADD CONSTRAINT [fk_users_department] FOREIGN KEY ([department_id])
        REFERENCES [flowpilot].[departments] ([id]) ON DELETE NO ACTION;

ALTER TABLE [flowpilot].[users]
    ADD CONSTRAINT [fk_users_position] FOREIGN KEY ([position_id])
        REFERENCES [flowpilot].[positions] ([id]) ON DELETE NO ACTION;
