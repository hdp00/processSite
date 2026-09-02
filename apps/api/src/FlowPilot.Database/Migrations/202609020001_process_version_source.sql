ALTER TABLE [flowpilot].[workflow_definition_versions]
    ADD [source_version_id] uniqueidentifier NULL,
        [source_version_label] nvarchar(100) NULL,
        CONSTRAINT [ck_workflow_definition_versions_source]
        CHECK
        (
            ([source_version_id] IS NULL AND [source_version_label] IS NULL)
            OR
            ([source_version_id] IS NOT NULL AND LEN(LTRIM(RTRIM([source_version_label]))) > 0)
        );
