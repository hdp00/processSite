using System.Collections.Frozen;

namespace FlowPilot.Infrastructure.Persistence.Schema;

public sealed class SqlServerSchemaSnapshot
{
    public SqlServerSchemaSnapshot(
        IEnumerable<string> tables,
        IEnumerable<string> columns,
        IEnumerable<string> constraints,
        IEnumerable<string> indexes,
        IEnumerable<string> triggers,
        IEnumerable<string> otherObjects,
        IEnumerable<string> columnSignatures,
        IEnumerable<string> checkConstraintSignatures,
        IEnumerable<string> foreignKeySignatures,
        IEnumerable<string> keyConstraintSignatures,
        IEnumerable<string> indexSignatures,
        IEnumerable<string> triggerSignatures)
    {
        Tables = Freeze(tables);
        Columns = Freeze(columns);
        Constraints = Freeze(constraints);
        Indexes = Freeze(indexes);
        Triggers = Freeze(triggers);
        OtherObjects = Freeze(otherObjects);
        ColumnSignatures = Freeze(columnSignatures);
        CheckConstraintSignatures = Freeze(checkConstraintSignatures);
        ForeignKeySignatures = Freeze(foreignKeySignatures);
        KeyConstraintSignatures = Freeze(keyConstraintSignatures);
        IndexSignatures = Freeze(indexSignatures);
        TriggerSignatures = Freeze(triggerSignatures);
    }

    public IReadOnlySet<string> Tables { get; }

    public IReadOnlySet<string> Columns { get; }

    public IReadOnlySet<string> Constraints { get; }

    public IReadOnlySet<string> Indexes { get; }

    public IReadOnlySet<string> Triggers { get; }

    public IReadOnlySet<string> OtherObjects { get; }

    public IReadOnlySet<string> ColumnSignatures { get; }

    public IReadOnlySet<string> CheckConstraintSignatures { get; }

    public IReadOnlySet<string> ForeignKeySignatures { get; }

    public IReadOnlySet<string> KeyConstraintSignatures { get; }

    public IReadOnlySet<string> IndexSignatures { get; }

    public IReadOnlySet<string> TriggerSignatures { get; }

    private static FrozenSet<string> Freeze(IEnumerable<string> values)
    {
        ArgumentNullException.ThrowIfNull(values);
        return values.ToFrozenSet(StringComparer.Ordinal);
    }
}
