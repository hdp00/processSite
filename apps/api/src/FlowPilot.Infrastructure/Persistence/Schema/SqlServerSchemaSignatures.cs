namespace FlowPilot.Infrastructure.Persistence.Schema;

public static class SqlServerSchemaSignatures
{
    public static string Column(
        string table,
        string column,
        string typeSchema,
        string sqlTypeName,
        int maxLength,
        byte precision,
        byte scale,
        bool isUserDefined,
        bool isNullable,
        string? collation,
        bool isComputed,
        string? computedDefinition,
        bool? isPersisted,
        bool isIdentity,
        string? identitySeed,
        string? identityIncrement,
        bool isRowGuidColumn,
        bool isSparse,
        bool isAnsiPadded) =>
        $"{table}.{column}|type={typeSchema}." +
        $"{FormatSqlType(sqlTypeName, maxLength, precision, scale)}" +
        $"|userDefined={FormatBoolean(isUserDefined)}" +
        $"|nullable={FormatBoolean(isNullable)}" +
        $"|collation={FormatOptionalValue(collation)}" +
        $"|computed={FormatBoolean(isComputed)}" +
        $"|computedDefinition={FormatComputedDefinition(isComputed, computedDefinition)}" +
        $"|persisted={FormatComputedBoolean(isComputed, isPersisted)}" +
        $"|identity={FormatBoolean(isIdentity)}" +
        $"|seed={FormatIdentityValue(isIdentity, identitySeed)}" +
        $"|increment={FormatIdentityValue(isIdentity, identityIncrement)}" +
        $"|rowGuid={FormatBoolean(isRowGuidColumn)}" +
        $"|sparse={FormatBoolean(isSparse)}" +
        $"|ansiPadded={FormatBoolean(isAnsiPadded)}";

    public static string ColumnFromDeclaration(
        string table,
        string column,
        string sqlTypeDeclaration,
        bool isNullable,
        bool ansiPaddingEnabled,
        string? declaredCollation = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sqlTypeDeclaration);
        var normalizedType = string.Concat(
            sqlTypeDeclaration.Where(character => !char.IsWhiteSpace(character)))
            .ToLowerInvariant();
        var baseType = normalizedType.Split('(', 2)[0];
        var collation = IsCollatableType(baseType)
            ? NormalizeDeclaredCollation(declaredCollation)
            : null;
        var isAnsiPadded = UsesAnsiPaddingOnBehavior(
            normalizedType,
            baseType,
            ansiPaddingEnabled);
        return $"{table}.{column}|type=sys.{normalizedType}|userDefined=0" +
            $"|nullable={FormatBoolean(isNullable)}" +
            $"|collation={FormatOptionalValue(collation)}" +
            "|computed=0|computedDefinition=-|persisted=0" +
            "|identity=0|seed=-|increment=-|rowGuid=0|sparse=0" +
            $"|ansiPadded={FormatBoolean(isAnsiPadded)}";
    }

    public static string CheckConstraint(
        string table,
        string name,
        bool isDisabled,
        bool isTrusted,
        bool isNotForReplication,
        string? definition) =>
        $"{table}.{name}|disabled={FormatBoolean(isDisabled)}" +
        $"|trusted={FormatBoolean(isTrusted)}" +
        $"|notForReplication={FormatBoolean(isNotForReplication)}" +
        $"|definition={ExpressionFingerprint(definition)}";

    public static string ForeignKey(
        string table,
        string name,
        bool isDisabled,
        bool isTrusted,
        bool isNotForReplication,
        string deleteAction,
        string updateAction,
        IEnumerable<SqlServerForeignKeyColumn> columns)
    {
        ArgumentNullException.ThrowIfNull(columns);
        var columnSignature = string.Join(
            ',',
            columns.Select(column =>
                $"{column.ParentColumn}>{column.ReferencedSchema}." +
                $"{column.ReferencedTable}.{column.ReferencedColumn}"));
        return $"{table}.{name}|disabled={FormatBoolean(isDisabled)}" +
            $"|trusted={FormatBoolean(isTrusted)}" +
            $"|notForReplication={FormatBoolean(isNotForReplication)}" +
            $"|delete={NormalizeAction(deleteAction)}" +
            $"|update={NormalizeAction(updateAction)}" +
            $"|columns={columnSignature}";
    }

    public static string KeyConstraint(
        string table,
        string name,
        string kind,
        string indexType,
        bool isDisabled,
        IEnumerable<SqlServerIndexKeyColumn> keyColumns)
    {
        ArgumentNullException.ThrowIfNull(keyColumns);
        return $"{table}.{name}|kind={kind.ToUpperInvariant()}" +
            $"|type={indexType.ToUpperInvariant()}" +
            $"|disabled={FormatBoolean(isDisabled)}" +
            $"|keys={FormatKeyColumns(keyColumns)}";
    }

    public static string Index(
        string table,
        string name,
        bool isUnique,
        bool isDisabled,
        string indexType,
        IEnumerable<SqlServerIndexKeyColumn> keyColumns,
        IEnumerable<string> includedColumns,
        bool hasFilter,
        string? filterDefinition)
    {
        ArgumentNullException.ThrowIfNull(keyColumns);
        ArgumentNullException.ThrowIfNull(includedColumns);
        var includeSignature = string.Join(',', includedColumns);
        var filterSignature = hasFilter
            ? ExpressionFingerprint(filterDefinition)
            : "-";
        return $"{table}.{name}|unique={FormatBoolean(isUnique)}" +
            $"|disabled={FormatBoolean(isDisabled)}" +
            $"|type={indexType.ToUpperInvariant()}" +
            $"|keys={FormatKeyColumns(keyColumns)}" +
            $"|include={includeSignature}" +
            $"|filter={filterSignature}";
    }

    public static string Trigger(
        string table,
        string name,
        bool isDisabled,
        bool isInsteadOf,
        bool isNotForReplication,
        bool usesAnsiNulls,
        bool usesQuotedIdentifier,
        IEnumerable<string> events,
        string? definition)
    {
        ArgumentNullException.ThrowIfNull(events);
        var eventSignature = string.Join(
            ',',
            events
                .Select(value => value.ToUpperInvariant())
                .Order(StringComparer.Ordinal));
        var definitionSignature = string.IsNullOrWhiteSpace(definition)
            ? "missing"
            : SqlDefinitionFingerprint.ComputeModule(definition);
        return $"{table}.{name}|disabled={FormatBoolean(isDisabled)}" +
            $"|kind={(isInsteadOf ? "INSTEAD_OF" : "AFTER")}" +
            $"|notForReplication={FormatBoolean(isNotForReplication)}" +
            $"|usesAnsiNulls={FormatBoolean(usesAnsiNulls)}" +
            $"|usesQuotedIdentifier={FormatBoolean(usesQuotedIdentifier)}" +
            $"|events={eventSignature}" +
            $"|definition={definitionSignature}";
    }

    private static string FormatSqlType(
        string sqlTypeName,
        int maxLength,
        byte precision,
        byte scale)
    {
        var typeName = sqlTypeName.ToLowerInvariant();
        return typeName switch
        {
            "nvarchar" or "nchar" =>
                $"{typeName}({FormatLength(maxLength < 0 ? maxLength : maxLength / 2)})",
            "varchar" or "char" or "varbinary" or "binary" =>
                $"{typeName}({FormatLength(maxLength)})",
            "decimal" or "numeric" => $"{typeName}({precision},{scale})",
            "datetime2" or "datetimeoffset" or "time" => $"{typeName}({scale})",
            _ => typeName,
        };
    }

    private static string FormatKeyColumns(IEnumerable<SqlServerIndexKeyColumn> keyColumns) =>
        string.Join(
            ',',
            keyColumns.Select(column =>
                $"{column.Name}:{(column.IsDescending ? "DESC" : "ASC")}"));

    private static string ExpressionFingerprint(string? definition) =>
        string.IsNullOrWhiteSpace(definition)
            ? "missing"
            : SqlDefinitionFingerprint.ComputeExpression(definition);

    private static string FormatComputedDefinition(bool isComputed, string? definition) =>
        isComputed ? ExpressionFingerprint(definition) : "-";

    private static string FormatComputedBoolean(bool isComputed, bool? value) =>
        !isComputed
            ? "0"
            : value.HasValue ? FormatBoolean(value.Value).ToString() : "missing";

    private static string FormatIdentityValue(bool isIdentity, string? value) =>
        !isIdentity
            ? "-"
            : string.IsNullOrWhiteSpace(value) ? "missing" : value;

    private static string FormatOptionalValue(string? value) =>
        string.IsNullOrWhiteSpace(value) ? "-" : value;

    private static string NormalizeDeclaredCollation(string? declaredCollation) =>
        string.IsNullOrWhiteSpace(declaredCollation) ||
        string.Equals(declaredCollation, "DATABASE_DEFAULT", StringComparison.OrdinalIgnoreCase)
            ? "database_default"
            : declaredCollation;

    private static bool IsCollatableType(string typeName) =>
        typeName is "char" or "varchar" or "text" or
            "nchar" or "nvarchar" or "ntext";

    private static bool UsesAnsiPaddingOnBehavior(
        string normalizedType,
        string baseType,
        bool ansiPaddingEnabled)
    {
        if (baseType is "nchar" or "nvarchar" or "ntext" or "text" or
            "image" or "sql_variant" ||
            normalizedType is "varchar(max)" or "varbinary(max)")
        {
            return true;
        }

        return ansiPaddingEnabled &&
            baseType is "char" or "varchar" or "binary" or "varbinary";
    }

    private static string FormatLength(int maxLength) =>
        maxLength < 0 ? "max" : maxLength.ToString(System.Globalization.CultureInfo.InvariantCulture);

    private static char FormatBoolean(bool value) => value ? '1' : '0';

    private static string NormalizeAction(string action) =>
        action.Replace(' ', '_').ToUpperInvariant();
}

public readonly record struct SqlServerForeignKeyColumn(
    string ParentColumn,
    string ReferencedSchema,
    string ReferencedTable,
    string ReferencedColumn);

public readonly record struct SqlServerIndexKeyColumn(string Name, bool IsDescending);
