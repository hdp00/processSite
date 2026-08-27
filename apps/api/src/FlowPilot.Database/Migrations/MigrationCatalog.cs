using System.Collections.ObjectModel;
using System.Reflection;
using System.Text;

namespace FlowPilot.Database.Migrations;

public static class MigrationCatalog
{
    public const string CurrentSchemaVersion = "202608260001";
    private const string CurrentMigrationName = "initial_schema";
    private const string CurrentResourceSuffix =
        ".Migrations.202608260001_initial_schema.sql";

    private static readonly Lazy<ReadOnlyCollection<SchemaMigration>> DefaultMigrations =
        new(LoadDefaultMigrations, LazyThreadSafetyMode.ExecutionAndPublication);

    public static IReadOnlyList<SchemaMigration> Migrations => DefaultMigrations.Value;

    private static ReadOnlyCollection<SchemaMigration> LoadDefaultMigrations()
    {
        var assembly = typeof(MigrationCatalog).Assembly;
        var matches = assembly
            .GetManifestResourceNames()
            .Where(name => name.EndsWith(CurrentResourceSuffix, StringComparison.Ordinal))
            .ToArray();

        if (matches.Length != 1)
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.MigrationCatalogInvalid);
        }

        try
        {
            using var stream = assembly.GetManifestResourceStream(matches[0]);
            if (stream is null)
            {
                throw new DatabaseMigrationException(DatabaseMigrationFailure.MigrationCatalogInvalid);
            }

            using var reader = new StreamReader(
                stream,
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true),
                detectEncodingFromByteOrderMarks: true);
            var migration = new SchemaMigration(
                CurrentSchemaVersion,
                CurrentMigrationName,
                reader.ReadToEnd());

            return Array.AsReadOnly([migration]);
        }
        catch (DatabaseMigrationException)
        {
            throw;
        }
        catch (Exception exception) when (
            exception is IOException or UnauthorizedAccessException or DecoderFallbackException)
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.MigrationCatalogInvalid);
        }
    }
}
