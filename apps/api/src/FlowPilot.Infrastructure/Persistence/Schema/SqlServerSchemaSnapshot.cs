using System.Collections.Frozen;

namespace FlowPilot.Infrastructure.Persistence.Schema;

public sealed class SqlServerSchemaSnapshot
{
    public SqlServerSchemaSnapshot(
        IEnumerable<string> tables,
        IEnumerable<string> columns,
        IEnumerable<string> constraints,
        IEnumerable<string> indexes,
        IEnumerable<string> triggers)
    {
        Tables = Freeze(tables);
        Columns = Freeze(columns);
        Constraints = Freeze(constraints);
        Indexes = Freeze(indexes);
        Triggers = Freeze(triggers);
    }

    public IReadOnlySet<string> Tables { get; }

    public IReadOnlySet<string> Columns { get; }

    public IReadOnlySet<string> Constraints { get; }

    public IReadOnlySet<string> Indexes { get; }

    public IReadOnlySet<string> Triggers { get; }

    private static FrozenSet<string> Freeze(IEnumerable<string> values)
    {
        ArgumentNullException.ThrowIfNull(values);
        return values.ToFrozenSet(StringComparer.Ordinal);
    }
}
