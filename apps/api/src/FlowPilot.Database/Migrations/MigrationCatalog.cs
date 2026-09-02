using System.Collections.ObjectModel;
using System.Reflection;
using System.Text;
using FlowPilot.Application.Health;

namespace FlowPilot.Database.Migrations;

public static class MigrationCatalog
{
    public const string CurrentSchemaVersion = DatabaseSchemaVersion.Current;
    private static readonly (string Id, string Name, string ResourceSuffix)[] MigrationDefinitions =
    [
        ("202608260001", "initial_schema", ".Migrations.202608260001_initial_schema.sql"),
        ("202608270001", "optional_user_organization", ".Migrations.202608270001_optional_user_organization.sql"),
        ("202608280001", "process_version_change_note", ".Migrations.202608280001_process_version_change_note.sql"),
        ("202608280002", "number_counter_prefix_length", ".Migrations.202608280002_number_counter_prefix_length.sql"),
        ("202608280003", "session_impersonation_link", ".Migrations.202608280003_session_impersonation_link.sql"),
        ("202608310001", "optional_user_email", ".Migrations.202608310001_optional_user_email.sql"),
        ("202609020001", "process_version_source", ".Migrations.202609020001_process_version_source.sql"),
    ];

    private static readonly Lazy<ReadOnlyCollection<SchemaMigration>> DefaultMigrations =
        new(LoadDefaultMigrations, LazyThreadSafetyMode.ExecutionAndPublication);

    public static IReadOnlyList<SchemaMigration> Migrations => DefaultMigrations.Value;

    private static ReadOnlyCollection<SchemaMigration> LoadDefaultMigrations()
    {
        var assembly = typeof(MigrationCatalog).Assembly;
        try
        {
            var resourceNames = assembly.GetManifestResourceNames();
            var migrations = new List<SchemaMigration>(MigrationDefinitions.Length);
            foreach (var definition in MigrationDefinitions)
            {
                var matches = resourceNames
                    .Where(name => name.EndsWith(definition.ResourceSuffix, StringComparison.Ordinal))
                    .ToArray();
                if (matches.Length != 1)
                {
                    throw new DatabaseMigrationException(DatabaseMigrationFailure.MigrationCatalogInvalid);
                }

                using var stream = assembly.GetManifestResourceStream(matches[0]);
                if (stream is null)
                {
                    throw new DatabaseMigrationException(DatabaseMigrationFailure.MigrationCatalogInvalid);
                }

                using var reader = new StreamReader(
                    stream,
                    new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true),
                    detectEncodingFromByteOrderMarks: true);
                migrations.Add(new SchemaMigration(definition.Id, definition.Name, reader.ReadToEnd()));
            }

            return Array.AsReadOnly(migrations.ToArray());
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
