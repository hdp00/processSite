ALTER TABLE [flowpilot].[users] DROP CONSTRAINT [ck_users_password_hash];

ALTER TABLE [flowpilot].[users]
    ADD CONSTRAINT [ck_users_password_hash] CHECK
    (
        ([authentication_mode] = N'password' AND [password_hash] IS NOT NULL AND LEN([password_hash]) > 0)
        OR ([authentication_mode] = N'domain' AND ([password_hash] IS NULL OR LEN([password_hash]) > 0))
    );
