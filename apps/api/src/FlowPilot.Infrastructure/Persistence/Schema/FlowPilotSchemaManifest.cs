using System.Collections.Frozen;
using System.Reflection;
using System.Text;

namespace FlowPilot.Infrastructure.Persistence.Schema;

public sealed class FlowPilotSchemaManifest
{
    public const string CurrentVersion = "202608260001";
    public const string FlowPilotSchemaName = "flowpilot";

    private const string CurrentResourceSuffix =
        ".Persistence.Schema.Manifests.202608260001.schema.txt";

    private static readonly Lazy<FlowPilotSchemaManifest> CurrentManifest =
        new(LoadCurrent, LazyThreadSafetyMode.ExecutionAndPublication);

    public FlowPilotSchemaManifest(
        string version,
        string schemaName,
        IEnumerable<string> tables,
        IEnumerable<string> columns,
        IEnumerable<string> constraints,
        IEnumerable<string> indexes,
        IEnumerable<string> triggers,
        IEnumerable<string> columnSignatures,
        IEnumerable<string> checkConstraintSignatures,
        IEnumerable<string> foreignKeySignatures,
        IEnumerable<string> keyConstraintSignatures,
        IEnumerable<string> indexSignatures,
        IEnumerable<string> triggerSignatures)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(version);
        ArgumentException.ThrowIfNullOrWhiteSpace(schemaName);

        Version = version;
        SchemaName = schemaName;
        Tables = Freeze(tables, nameof(tables));
        Columns = Freeze(columns, nameof(columns));
        Constraints = Freeze(constraints, nameof(constraints));
        Indexes = Freeze(indexes, nameof(indexes));
        Triggers = Freeze(triggers, nameof(triggers));
        ColumnSignatures = FreezeSignatures(columnSignatures, nameof(columnSignatures));
        CheckConstraintSignatures = FreezeSignatures(
            checkConstraintSignatures,
            nameof(checkConstraintSignatures));
        ForeignKeySignatures = FreezeSignatures(
            foreignKeySignatures,
            nameof(foreignKeySignatures));
        KeyConstraintSignatures = FreezeSignatures(
            keyConstraintSignatures,
            nameof(keyConstraintSignatures));
        IndexSignatures = FreezeSignatures(indexSignatures, nameof(indexSignatures));
        TriggerSignatures = FreezeSignatures(triggerSignatures, nameof(triggerSignatures));
    }

    public static FlowPilotSchemaManifest Current => CurrentManifest.Value;

    public string Version { get; }

    public string SchemaName { get; }

    public IReadOnlySet<string> Tables { get; }

    public IReadOnlySet<string> Columns { get; }

    public IReadOnlySet<string> Constraints { get; }

    public IReadOnlySet<string> Indexes { get; }

    public IReadOnlySet<string> Triggers { get; }

    public IReadOnlySet<string> ColumnSignatures { get; }

    public IReadOnlySet<string> CheckConstraintSignatures { get; }

    public IReadOnlySet<string> ForeignKeySignatures { get; }

    public IReadOnlySet<string> KeyConstraintSignatures { get; }

    public IReadOnlySet<string> IndexSignatures { get; }

    public IReadOnlySet<string> TriggerSignatures { get; }

    private static FrozenSet<string> Freeze(
        IEnumerable<string> values,
        string parameterName)
    {
        ArgumentNullException.ThrowIfNull(values, parameterName);

        var items = values.ToArray();
        if (items.Any(string.IsNullOrWhiteSpace))
        {
            throw new ArgumentException("Schema object keys cannot be blank.", parameterName);
        }

        var frozen = items.ToFrozenSet(StringComparer.Ordinal);
        if (frozen.Count != items.Length)
        {
            throw new ArgumentException("Schema object keys must be unique.", parameterName);
        }

        return frozen;
    }

    private static FrozenSet<string> FreezeSignatures(
        IEnumerable<string> values,
        string parameterName)
    {
        var frozen = Freeze(values, parameterName);
        var identityCount = frozen
            .Select(value => value.Split('|', 2)[0])
            .Distinct(StringComparer.Ordinal)
            .Count();
        if (identityCount != frozen.Count)
        {
            throw new ArgumentException(
                "Schema signatures must have unique object identities.",
                parameterName);
        }

        return frozen;
    }

    private static FlowPilotSchemaManifest LoadCurrent()
    {
        var assembly = typeof(FlowPilotSchemaManifest).Assembly;
        var matches = assembly
            .GetManifestResourceNames()
            .Where(name => name.EndsWith(CurrentResourceSuffix, StringComparison.Ordinal))
            .ToArray();

        if (matches.Length != 1)
        {
            throw new InvalidOperationException("The FlowPilot schema manifest is unavailable.");
        }

        using var stream = assembly.GetManifestResourceStream(matches[0]);
        if (stream is null)
        {
            throw new InvalidOperationException("The FlowPilot schema manifest is unavailable.");
        }

        using var reader = new StreamReader(
            stream,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true),
            detectEncodingFromByteOrderMarks: true);
        var manifest = Parse(reader.ReadToEnd());

        if (!string.Equals(manifest.Version, CurrentVersion, StringComparison.Ordinal) ||
            !string.Equals(manifest.SchemaName, FlowPilotSchemaName, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("The FlowPilot schema manifest metadata is invalid.");
        }

        if (manifest.ColumnSignatures.Count != manifest.Columns.Count ||
            manifest.CheckConstraintSignatures.Count +
                manifest.ForeignKeySignatures.Count +
                manifest.KeyConstraintSignatures.Count != manifest.Constraints.Count ||
            manifest.IndexSignatures.Count != manifest.Indexes.Count ||
            manifest.TriggerSignatures.Count != manifest.Triggers.Count)
        {
            throw new InvalidOperationException("The FlowPilot schema manifest shape is invalid.");
        }

        return manifest;
    }

    private static FlowPilotSchemaManifest Parse(string content)
    {
        string? version = null;
        string? schemaName = null;
        string? section = null;
        var sections = new Dictionary<string, List<string>>(StringComparer.Ordinal)
        {
            ["tables"] = [],
            ["columns"] = [],
            ["constraints"] = [],
            ["indexes"] = [],
            ["triggers"] = [],
            ["columnSignatures"] = [],
            ["checkConstraintSignatures"] = [],
            ["foreignKeySignatures"] = [],
            ["keyConstraintSignatures"] = [],
            ["indexSignatures"] = [],
            ["triggerSignatures"] = [],
        };
        var visitedSections = new HashSet<string>(StringComparer.Ordinal);

        foreach (var rawLine in content.Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line[0] == '#')
            {
                continue;
            }

            if (line[0] == '[' && line[^1] == ']')
            {
                section = line[1..^1];
                if (!sections.ContainsKey(section) || !visitedSections.Add(section))
                {
                    throw new InvalidOperationException("The FlowPilot schema manifest is invalid.");
                }

                continue;
            }

            if (section is null)
            {
                if (line.StartsWith("version=", StringComparison.Ordinal))
                {
                    version = ReadSingleMetadataValue(version, line["version=".Length..]);
                }
                else if (line.StartsWith("schema=", StringComparison.Ordinal))
                {
                    schemaName = ReadSingleMetadataValue(schemaName, line["schema=".Length..]);
                }
                else
                {
                    throw new InvalidOperationException("The FlowPilot schema manifest is invalid.");
                }

                continue;
            }

            sections[section].Add(line);
        }

        if (version is null ||
            schemaName is null ||
            visitedSections.Count != sections.Count)
        {
            throw new InvalidOperationException("The FlowPilot schema manifest is incomplete.");
        }

        return new FlowPilotSchemaManifest(
            version,
            schemaName,
            sections["tables"],
            sections["columns"],
            sections["constraints"],
            sections["indexes"],
            sections["triggers"],
            sections["columnSignatures"],
            sections["checkConstraintSignatures"],
            sections["foreignKeySignatures"],
            sections["keyConstraintSignatures"],
            sections["indexSignatures"],
            sections["triggerSignatures"]);
    }

    private static string ReadSingleMetadataValue(string? existingValue, string value)
    {
        if (existingValue is not null || string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidOperationException("The FlowPilot schema manifest metadata is invalid.");
        }

        return value;
    }
}
