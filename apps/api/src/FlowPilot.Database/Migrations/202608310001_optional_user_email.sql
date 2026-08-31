ALTER TABLE [flowpilot].[users] DROP CONSTRAINT [ck_users_email];

ALTER TABLE [flowpilot].[users]
    ADD CONSTRAINT [ck_users_email] CHECK
    (
        [is_builtin_super_admin] = 0 OR [email] = N''
    );
