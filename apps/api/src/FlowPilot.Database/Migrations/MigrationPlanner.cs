namespace FlowPilot.Database.Migrations;

public static class MigrationPlanner
{
    private const string SucceededResult = "succeeded";

    public static MigrationPlan CreatePlan(
        DatabaseMigrationState state,
        IReadOnlyList<SchemaMigration> catalog)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(catalog);

        ValidateCatalog(catalog);
        var entries = state.Entries ??
            throw new DatabaseMigrationException(DatabaseMigrationFailure.DatabaseStateUnknown);

        if (!state.FlowPilotSchemaExists && !state.MigrationLedgerExists)
        {
            if (state.HasUserObjects || entries.Count != 0)
            {
                throw new DatabaseMigrationException(DatabaseMigrationFailure.DatabaseStateUnknown);
            }

            return new MigrationPlan(catalog.ToArray());
        }

        if (!state.FlowPilotSchemaExists ||
            !state.MigrationLedgerExists ||
            !state.MigrationLedgerIsValid ||
            entries.Count == 0)
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.DatabaseStateUnknown);
        }

        var catalogById = catalog.ToDictionary(migration => migration.Id, StringComparer.Ordinal);
        var entriesById = new Dictionary<string, MigrationLedgerEntry>(StringComparer.Ordinal);

        foreach (var entry in entries)
        {
            if (!entriesById.TryAdd(entry.MigrationId, entry))
            {
                throw new DatabaseMigrationException(DatabaseMigrationFailure.DatabaseStateUnknown);
            }

            if (!catalogById.TryGetValue(entry.MigrationId, out var migration))
            {
                throw new DatabaseMigrationException(DatabaseMigrationFailure.UnknownMigration);
            }

            if (!string.Equals(entry.Result, SucceededResult, StringComparison.Ordinal))
            {
                throw new DatabaseMigrationException(DatabaseMigrationFailure.MigrationNotSucceeded);
            }

            if (!string.Equals(entry.Checksum, migration.Checksum, StringComparison.Ordinal))
            {
                throw new DatabaseMigrationException(DatabaseMigrationFailure.MigrationChecksumMismatch);
            }
        }

        var firstPendingIndex = 0;
        while (firstPendingIndex < catalog.Count &&
               entriesById.ContainsKey(catalog[firstPendingIndex].Id))
        {
            firstPendingIndex++;
        }

        if (catalog.Skip(firstPendingIndex + 1).Any(migration => entriesById.ContainsKey(migration.Id)))
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.DatabaseStateUnknown);
        }

        return new MigrationPlan(catalog.Skip(firstPendingIndex).ToArray());
    }

    private static void ValidateCatalog(IReadOnlyList<SchemaMigration> catalog)
    {
        if (catalog.Count == 0)
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.MigrationCatalogInvalid);
        }

        for (var index = 0; index < catalog.Count; index++)
        {
            if (catalog[index] is null ||
                (index > 0 && string.CompareOrdinal(catalog[index - 1].Id, catalog[index].Id) >= 0))
            {
                throw new DatabaseMigrationException(DatabaseMigrationFailure.MigrationCatalogInvalid);
            }
        }
    }
}
