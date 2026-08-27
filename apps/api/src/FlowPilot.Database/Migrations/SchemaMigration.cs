namespace FlowPilot.Database.Migrations;

public sealed record SchemaMigration
{
    public SchemaMigration(string id, string name, string sql)
    {
        if (!IsValidIdentifier(id) || !IsValidName(name))
        {
            throw new DatabaseMigrationException(DatabaseMigrationFailure.MigrationCatalogInvalid);
        }

        SqlMigrationScriptPolicy.Validate(sql);

        Id = id;
        Name = name;
        Sql = SqlScriptChecksum.Normalize(sql);
        Checksum = SqlScriptChecksum.ComputeSha256(Sql);
    }

    public string Id { get; }

    public string Name { get; }

    public string Sql { get; }

    public string Checksum { get; }

    private static bool IsValidIdentifier(string? value) =>
        value is { Length: 12 } && value.All(char.IsAsciiDigit);

    private static bool IsValidName(string? value) =>
        !string.IsNullOrWhiteSpace(value) &&
        value.Length <= 100 &&
        value.All(character =>
            char.IsAsciiLetterOrDigit(character) || character == '_');
}
