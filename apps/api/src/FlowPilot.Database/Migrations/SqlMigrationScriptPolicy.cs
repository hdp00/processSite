namespace FlowPilot.Database.Migrations;

public static class SqlMigrationScriptPolicy
{
    public static void Validate(string sql)
    {
        if (string.IsNullOrWhiteSpace(sql))
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.MigrationCatalogInvalid);
        }

        foreach (var line in SqlScriptChecksum.Normalize(sql).Split('\n'))
        {
            var statement = line.TrimStart();
            if (IsGoBatchSeparator(statement) ||
                statement.StartsWith(":r", StringComparison.OrdinalIgnoreCase) ||
                statement.StartsWith(":setvar", StringComparison.OrdinalIgnoreCase) ||
                statement.StartsWith("USE ", StringComparison.OrdinalIgnoreCase) ||
                statement.StartsWith("BEGIN TRAN", StringComparison.OrdinalIgnoreCase) ||
                statement.StartsWith("COMMIT", StringComparison.OrdinalIgnoreCase) ||
                statement.StartsWith("ROLLBACK", StringComparison.OrdinalIgnoreCase))
            {
                throw new DatabaseMigrationException(DatabaseMigrationFailure.MigrationCatalogInvalid);
            }
        }
    }

    private static bool IsGoBatchSeparator(string statement)
    {
        if (string.Equals(statement, "GO", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return statement.StartsWith("GO ", StringComparison.OrdinalIgnoreCase) ||
            statement.StartsWith("GO\t", StringComparison.OrdinalIgnoreCase);
    }
}
