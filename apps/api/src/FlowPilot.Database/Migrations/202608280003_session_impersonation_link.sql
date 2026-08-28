ALTER TABLE [flowpilot].[sessions]
    ADD [impersonation_record_id] uniqueidentifier NULL;

ALTER TABLE [flowpilot].[sessions]
    ADD CONSTRAINT [fk_sessions_impersonation_record]
        FOREIGN KEY ([impersonation_record_id])
        REFERENCES [flowpilot].[impersonation_records] ([id]) ON DELETE NO ACTION;

EXEC
(
    N'CREATE UNIQUE INDEX [ux_sessions_impersonation_record]
      ON [flowpilot].[sessions] ([impersonation_record_id])
      WHERE [impersonation_record_id] IS NOT NULL;'
);
