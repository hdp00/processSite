ALTER TABLE [flowpilot].[number_counters]
    DROP CONSTRAINT [pk_number_counters];

ALTER TABLE [flowpilot].[number_counters]
    ALTER COLUMN [prefix] nvarchar(30) NOT NULL;

ALTER TABLE [flowpilot].[number_counters]
    ADD CONSTRAINT [pk_number_counters]
        PRIMARY KEY CLUSTERED ([prefix], [year_month]);
