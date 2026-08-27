using FlowPilot.Infrastructure.Persistence.Schema;

namespace FlowPilot.UnitTests.Persistence.Schema;

public sealed class SqlServerSchemaSignaturesTests
{
    [Theory]
    [InlineData("nvarchar", -1, 0, 0, "sys.nvarchar(max)")]
    [InlineData("nvarchar", 200, 0, 0, "sys.nvarchar(100)")]
    [InlineData("varchar", 64, 0, 0, "sys.varchar(64)")]
    [InlineData("decimal", 17, 38, 10, "sys.decimal(38,10)")]
    [InlineData("datetime2", 7, 0, 3, "sys.datetime2(3)")]
    public void Column_NormalizesSqlServerCatalogTypeMetadata(
        string typeName,
        int maxLength,
        byte precision,
        byte scale,
        string expectedType)
    {
        var signature = SqlServerSchemaSignatures.Column(
            "table",
            "column",
            "sys",
            typeName,
            maxLength,
            precision,
            scale,
            isUserDefined: false,
            isNullable: true,
            collation: typeName is "nvarchar" or "varchar" ? "database_default" : null,
            isComputed: false,
            computedDefinition: null,
            isPersisted: null,
            isIdentity: false,
            identitySeed: null,
            identityIncrement: null,
            isRowGuidColumn: false,
            isSparse: false,
            isAnsiPadded: typeName is "nvarchar" or "varchar");

        Assert.Equal(
            $"table.column|type={expectedType}|userDefined=0|nullable=1" +
            $"|collation={(typeName is "nvarchar" or "varchar" ? "database_default" : "-")}" +
            "|computed=0|computedDefinition=-|persisted=0" +
            "|identity=0|seed=-|increment=-|rowGuid=0|sparse=0" +
            $"|ansiPadded={(typeName is "nvarchar" or "varchar" ? "1" : "0")}",
            signature);
    }

    [Fact]
    public void Column_PreservesComputedIdentityAndStorageMetadata()
    {
        const string computedDefinition = "([quantity] * [unit_price])";
        var signature = SqlServerSchemaSignatures.Column(
            "lines",
            "total",
            "sys",
            "decimal",
            maxLength: 17,
            precision: 38,
            scale: 10,
            isUserDefined: false,
            isNullable: true,
            collation: null,
            isComputed: true,
            computedDefinition,
            isPersisted: true,
            isIdentity: true,
            identitySeed: "10",
            identityIncrement: "5",
            isRowGuidColumn: true,
            isSparse: true,
            isAnsiPadded: false);

        Assert.Equal(
            "lines.total|type=sys.decimal(38,10)|userDefined=0|nullable=1" +
            "|collation=-|computed=1" +
            $"|computedDefinition={SqlDefinitionFingerprint.ComputeExpression(computedDefinition)}" +
            "|persisted=1|identity=1|seed=10|increment=5" +
            "|rowGuid=1|sparse=1|ansiPadded=0",
            signature);
    }

    [Fact]
    public void Column_HiddenRequiredMetadataFailsClosed()
    {
        var signature = SqlServerSchemaSignatures.Column(
            "table",
            "column",
            "sys",
            "int",
            maxLength: 4,
            precision: 10,
            scale: 0,
            isUserDefined: false,
            isNullable: false,
            collation: null,
            isComputed: true,
            computedDefinition: null,
            isPersisted: null,
            isIdentity: true,
            identitySeed: null,
            identityIncrement: null,
            isRowGuidColumn: false,
            isSparse: false,
            isAnsiPadded: false);

        Assert.Contains("|computedDefinition=missing|persisted=missing|", signature);
        Assert.Contains("|identity=1|seed=missing|increment=missing|", signature);
    }

    [Theory]
    [InlineData("nvarchar(100)", true, null, "database_default", true)]
    [InlineData("varchar(64)", true, "Latin1_General_100_BIN2", "Latin1_General_100_BIN2", true)]
    [InlineData("binary(32)", true, null, "-", true)]
    [InlineData("int", true, null, "-", false)]
    [InlineData("nvarchar(100)", false, null, "database_default", true)]
    [InlineData("varchar(100)", false, null, "database_default", false)]
    [InlineData("varchar(max)", false, null, "database_default", true)]
    public void ColumnFromDeclaration_RecordsDefaultsThatAreAbsentFromTheDdl(
        string type,
        bool ansiPaddingEnabled,
        string? declaredCollation,
        string expectedCollation,
        bool expectedAnsiPadded)
    {
        var signature = SqlServerSchemaSignatures.ColumnFromDeclaration(
            "table",
            "column",
            type,
            isNullable: false,
            ansiPaddingEnabled,
            declaredCollation);

        Assert.Contains($"|collation={expectedCollation}|", signature);
        Assert.Contains("|computed=0|computedDefinition=-|persisted=0|", signature);
        Assert.Contains("|identity=0|seed=-|increment=-|rowGuid=0|sparse=0|", signature);
        Assert.EndsWith(
            $"|ansiPadded={(expectedAnsiPadded ? "1" : "0")}",
            signature,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ForeignKey_PreservesActionsAndCompositeColumnOrdinal()
    {
        var signature = SqlServerSchemaSignatures.ForeignKey(
            "child",
            "fk_child_parent",
            isDisabled: false,
            isTrusted: true,
            isNotForReplication: false,
            deleteAction: "NO ACTION",
            updateAction: "CASCADE",
            columns: [
                new SqlServerForeignKeyColumn("parent_id", "flowpilot", "parent", "id"),
                new SqlServerForeignKeyColumn("version", "flowpilot", "parent", "version"),
            ]);

        Assert.Equal(
            "child.fk_child_parent|disabled=0|trusted=1|notForReplication=0" +
            "|delete=NO_ACTION|update=CASCADE" +
            "|columns=parent_id>flowpilot.parent.id,version>flowpilot.parent.version",
            signature);
    }

    [Fact]
    public void Index_PreservesUniqueDisabledKeysIncludesAndFilterDefinition()
    {
        const string filter = "([status] = N'pending')";
        var signature = SqlServerSchemaSignatures.Index(
            "tasks",
            "ix_tasks_pending",
            isUnique: true,
            isDisabled: true,
            indexType: "NONCLUSTERED",
            keyColumns: [
                new SqlServerIndexKeyColumn("status", IsDescending: false),
                new SqlServerIndexKeyColumn("created_at", IsDescending: true),
            ],
            includedColumns: ["assignee_id"],
            hasFilter: true,
            filterDefinition: filter);

        Assert.Equal(
            "tasks.ix_tasks_pending|unique=1|disabled=1|type=NONCLUSTERED" +
            "|keys=status:ASC,created_at:DESC|include=assignee_id" +
            $"|filter={SqlDefinitionFingerprint.ComputeExpression(filter)}",
            signature);
    }

    [Fact]
    public void Trigger_PreservesModuleOptionsAndSortsEvents()
    {
        const string definition = "CREATE TRIGGER [flowpilot].[tr] ON [flowpilot].[t] " +
            "INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, 'blocked', 1; END;";

        var signature = SqlServerSchemaSignatures.Trigger(
            "t",
            "tr",
            isDisabled: true,
            isInsteadOf: true,
            isNotForReplication: true,
            usesAnsiNulls: true,
            usesQuotedIdentifier: true,
            events: ["UPDATE", "DELETE"],
            definition: definition);

        Assert.Equal(
            "t.tr|disabled=1|kind=INSTEAD_OF|notForReplication=1" +
            "|usesAnsiNulls=1|usesQuotedIdentifier=1|events=DELETE,UPDATE" +
            $"|definition={SqlDefinitionFingerprint.ComputeModule(definition)}",
            signature);
    }

    [Fact]
    public void DefinitionMetadataThatIsHiddenFailsClosedWithAMissingSentinel()
    {
        var check = SqlServerSchemaSignatures.CheckConstraint(
            "table",
            "ck_table",
            isDisabled: false,
            isTrusted: true,
            isNotForReplication: false,
            definition: null);
        var filteredIndex = SqlServerSchemaSignatures.Index(
            "table",
            "ix_table",
            isUnique: false,
            isDisabled: false,
            indexType: "NONCLUSTERED",
            keyColumns: [new SqlServerIndexKeyColumn("id", IsDescending: false)],
            includedColumns: [],
            hasFilter: true,
            filterDefinition: null);

        Assert.EndsWith("|definition=missing", check, StringComparison.Ordinal);
        Assert.EndsWith("|filter=missing", filteredIndex, StringComparison.Ordinal);
    }
}
