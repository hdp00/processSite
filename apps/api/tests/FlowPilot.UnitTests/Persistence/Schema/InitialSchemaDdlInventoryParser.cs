using System.Text.RegularExpressions;
using FlowPilot.Infrastructure.Persistence.Schema;

namespace FlowPilot.UnitTests.Persistence.Schema;

public static partial class InitialSchemaDdlInventoryParser
{
    public static InitialSchemaDdlInventory Parse(string sql)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sql);

        var tables = new HashSet<string>(StringComparer.Ordinal);
        var columns = new HashSet<string>(StringComparer.Ordinal);
        var constraints = new HashSet<string>(StringComparer.Ordinal);
        var indexes = new HashSet<string>(StringComparer.Ordinal);
        var triggers = new HashSet<string>(StringComparer.Ordinal);
        var columnSignatures = new HashSet<string>(StringComparer.Ordinal);
        var checkConstraintSignatures = new HashSet<string>(StringComparer.Ordinal);
        var foreignKeySignatures = new HashSet<string>(StringComparer.Ordinal);
        var keyConstraintSignatures = new HashSet<string>(StringComparer.Ordinal);
        var indexSignatures = new HashSet<string>(StringComparer.Ordinal);
        var triggerSignatures = new HashSet<string>(StringComparer.Ordinal);
        var ansiPaddingSettings = AnsiPaddingRegex()
            .Matches(sql)
            .Cast<Match>()
            .ToArray();

        foreach (Match match in CreateTableRegex().Matches(sql))
        {
            var table = match.Groups["table"].Value;
            _ = tables.Add(table);
            var openingParenthesis = match.Index + match.Length - 1;
            var closingParenthesis = FindMatchingParenthesis(sql, openingParenthesis);
            var body = sql[(openingParenthesis + 1)..closingParenthesis];

            foreach (var item in SplitTopLevel(body))
            {
                if (item[0] == '[')
                {
                    var ansiPadding = ansiPaddingSettings.LastOrDefault(
                        setting => setting.Index < match.Index);
                    if (ansiPadding is null)
                    {
                        throw new InvalidOperationException(
                            "The initial migration must set ANSI_PADDING before creating tables.");
                    }

                    ParseColumn(
                        table,
                        item,
                        columns,
                        columnSignatures,
                        string.Equals(
                            ansiPadding.Groups["value"].Value,
                            "ON",
                            StringComparison.OrdinalIgnoreCase));
                }
                else if (item.StartsWith("CONSTRAINT ", StringComparison.Ordinal))
                {
                    ParseConstraint(
                        table,
                        item,
                        constraints,
                        checkConstraintSignatures,
                        foreignKeySignatures,
                        keyConstraintSignatures);
                }
            }
        }

        foreach (Match match in AlterTableConstraintRegex().Matches(sql))
        {
            ParseConstraint(
                match.Groups["table"].Value,
                match.Groups["constraint"].Value.Trim(),
                constraints,
                checkConstraintSignatures,
                foreignKeySignatures,
                keyConstraintSignatures);
        }

        foreach (Match match in CreateIndexRegex().Matches(sql))
        {
            var statementEnd = FindStatementEnd(sql, match.Index);
            ParseIndex(
                sql[match.Index..(statementEnd + 1)],
                indexes,
                indexSignatures);
        }

        foreach (Match match in DynamicSqlRegex().Matches(sql))
        {
            var definition = match.Groups["body"].Value
                .Replace("''", "'", StringComparison.Ordinal);
            var trigger = TriggerHeaderRegex().Match(definition);
            if (!trigger.Success)
            {
                continue;
            }

            var table = trigger.Groups["table"].Value;
            var name = trigger.Groups["name"].Value;
            var isInsteadOf = string.Equals(
                trigger.Groups["kind"].Value,
                "INSTEAD OF",
                StringComparison.OrdinalIgnoreCase);
            var events = trigger.Groups["events"].Value
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

            _ = triggers.Add($"{table}.{name}");
            _ = triggerSignatures.Add(SqlServerSchemaSignatures.Trigger(
                table,
                name,
                isDisabled: false,
                isInsteadOf,
                isNotForReplication: false,
                usesAnsiNulls: true,
                usesQuotedIdentifier: true,
                events,
                definition));
        }

        return new InitialSchemaDdlInventory(
            tables,
            columns,
            constraints,
            indexes,
            triggers,
            columnSignatures,
            checkConstraintSignatures,
            foreignKeySignatures,
            keyConstraintSignatures,
            indexSignatures,
            triggerSignatures);
    }

    private static void ParseColumn(
        string table,
        string item,
        HashSet<string> columns,
        HashSet<string> signatures,
        bool ansiPaddingEnabled)
    {
        var match = ColumnRegex().Match(item);
        if (!match.Success)
        {
            throw new InvalidOperationException("The initial migration contains an unsupported column declaration.");
        }

        var column = match.Groups["name"].Value;
        var isNullable = string.Equals(
            match.Groups["nullability"].Value,
            "NULL",
            StringComparison.OrdinalIgnoreCase);
        _ = columns.Add($"{table}.{column}");
        _ = signatures.Add(SqlServerSchemaSignatures.ColumnFromDeclaration(
            table,
            column,
            match.Groups["type"].Value,
            isNullable,
            ansiPaddingEnabled,
            match.Groups["collation"].Success
                ? match.Groups["collation"].Value
                : null));
    }

    private static void ParseConstraint(
        string table,
        string item,
        HashSet<string> constraints,
        HashSet<string> checkSignatures,
        HashSet<string> foreignKeySignatures,
        HashSet<string> keySignatures)
    {
        var header = ConstraintHeaderRegex().Match(item);
        if (!header.Success)
        {
            throw new InvalidOperationException("The initial migration contains an unsupported constraint.");
        }

        var name = header.Groups["name"].Value;
        var kind = header.Groups["kind"].Value.ToUpperInvariant();
        _ = constraints.Add($"{table}.{name}");

        if (kind == "CHECK")
        {
            var definition = item[header.Length..].Trim();
            _ = checkSignatures.Add(SqlServerSchemaSignatures.CheckConstraint(
                table,
                name,
                isDisabled: false,
                isTrusted: true,
                isNotForReplication: false,
                definition));
            return;
        }

        if (kind == "FOREIGN KEY")
        {
            ParseForeignKey(table, name, item, foreignKeySignatures);
            return;
        }

        var key = KeyConstraintRegex().Match(item);
        if (!key.Success)
        {
            throw new InvalidOperationException("The initial migration contains an unsupported key constraint.");
        }

        var indexType = key.Groups["indexType"].Success
            ? key.Groups["indexType"].Value
            : kind == "PRIMARY KEY" ? "CLUSTERED" : "NONCLUSTERED";
        var keyColumns = ParseIndexColumns(key.Groups["columns"].Value);
        _ = keySignatures.Add(SqlServerSchemaSignatures.KeyConstraint(
            table,
            name,
            kind == "PRIMARY KEY" ? "PK" : "UQ",
            indexType,
            isDisabled: false,
            keyColumns));
    }

    private static void ParseForeignKey(
        string table,
        string name,
        string item,
        HashSet<string> signatures)
    {
        var match = ForeignKeyRegex().Match(item);
        if (!match.Success)
        {
            throw new InvalidOperationException("The initial migration contains an unsupported foreign key.");
        }

        var parentColumns = ParseBracketedColumnNames(match.Groups["parentColumns"].Value);
        var referencedColumns = ParseBracketedColumnNames(match.Groups["referencedColumns"].Value);
        if (parentColumns.Count != referencedColumns.Count)
        {
            throw new InvalidOperationException("The initial migration contains an invalid foreign key mapping.");
        }

        var mappings = parentColumns
            .Select((column, index) => new SqlServerForeignKeyColumn(
                column,
                match.Groups["referencedSchema"].Value,
                match.Groups["referencedTable"].Value,
                referencedColumns[index]));
        var deleteAction = match.Groups["deleteAction"].Success
            ? match.Groups["deleteAction"].Value
            : "NO ACTION";
        var updateAction = match.Groups["updateAction"].Success
            ? match.Groups["updateAction"].Value
            : "NO ACTION";

        _ = signatures.Add(SqlServerSchemaSignatures.ForeignKey(
            table,
            name,
            isDisabled: false,
            isTrusted: true,
            isNotForReplication: item.Contains(
                "NOT FOR REPLICATION",
                StringComparison.OrdinalIgnoreCase),
            deleteAction,
            updateAction,
            mappings));
    }

    private static void ParseIndex(
        string statement,
        HashSet<string> indexes,
        HashSet<string> signatures)
    {
        var header = IndexHeaderRegex().Match(statement);
        if (!header.Success)
        {
            throw new InvalidOperationException("The initial migration contains an unsupported index.");
        }

        var table = header.Groups["table"].Value;
        var name = header.Groups["name"].Value;
        var openingParenthesis = statement.IndexOf('(', header.Index + header.Length - 1);
        var closingParenthesis = FindMatchingParenthesis(statement, openingParenthesis);
        var keyColumns = ParseIndexColumns(
            statement[(openingParenthesis + 1)..closingParenthesis]);
        var remainder = statement[(closingParenthesis + 1)..];
        var includeMatch = IncludeRegex().Match(remainder);
        IReadOnlyList<string> includedColumns = [];
        if (includeMatch.Success)
        {
            var includeOpening = remainder.IndexOf(
                '(',
                includeMatch.Index + includeMatch.Length - 1);
            var includeClosing = FindMatchingParenthesis(remainder, includeOpening);
            includedColumns = ParseBracketedColumnNames(
                remainder[(includeOpening + 1)..includeClosing]);
        }

        var filter = WhereRegex().Match(remainder);
        var hasFilter = filter.Success;
        var filterDefinition = hasFilter ? filter.Groups["definition"].Value.Trim() : null;
        var indexType = header.Groups["indexType"].Success
            ? header.Groups["indexType"].Value
            : "NONCLUSTERED";

        _ = indexes.Add($"{table}.{name}");
        _ = signatures.Add(SqlServerSchemaSignatures.Index(
            table,
            name,
            header.Groups["unique"].Success,
            isDisabled: false,
            indexType,
            keyColumns,
            includedColumns,
            hasFilter,
            filterDefinition));
    }

    private static List<SqlServerIndexKeyColumn> ParseIndexColumns(string value) =>
        SplitTopLevel(value)
            .Select(item =>
            {
                var match = IndexColumnRegex().Match(item);
                if (!match.Success)
                {
                    throw new InvalidOperationException(
                        "The initial migration contains an unsupported index column.");
                }

                return new SqlServerIndexKeyColumn(
                    match.Groups["name"].Value,
                    string.Equals(
                        match.Groups["direction"].Value,
                        "DESC",
                        StringComparison.OrdinalIgnoreCase));
            })
            .ToList();

    private static List<string> ParseBracketedColumnNames(string value) =>
        SplitTopLevel(value)
            .Select(item =>
            {
                var match = BracketedNameRegex().Match(item);
                if (!match.Success)
                {
                    throw new InvalidOperationException(
                        "The initial migration contains an unsupported column mapping.");
                }

                return match.Groups["name"].Value;
            })
            .ToList();

    private static List<string> SplitTopLevel(string value)
    {
        var items = new List<string>();
        var start = 0;
        var depth = 0;
        var inString = false;
        var inBracket = false;

        for (var index = 0; index < value.Length; index++)
        {
            var character = value[index];
            var next = index + 1 < value.Length ? value[index + 1] : '\0';
            if (inString)
            {
                if (character == '\'' && next == '\'')
                {
                    index++;
                }
                else if (character == '\'')
                {
                    inString = false;
                }

                continue;
            }

            if (inBracket)
            {
                if (character == ']' && next == ']')
                {
                    index++;
                }
                else if (character == ']')
                {
                    inBracket = false;
                }

                continue;
            }

            switch (character)
            {
                case '\'':
                    inString = true;
                    break;
                case '[':
                    inBracket = true;
                    break;
                case '(':
                    depth++;
                    break;
                case ')':
                    depth--;
                    break;
                case ',' when depth == 0:
                    items.Add(value[start..index].Trim());
                    start = index + 1;
                    break;
            }
        }

        items.Add(value[start..].Trim());
        return items.Where(item => item.Length > 0).ToList();
    }

    private static int FindMatchingParenthesis(string value, int openingParenthesis)
    {
        var depth = 0;
        var inString = false;
        var inBracket = false;

        for (var index = openingParenthesis; index < value.Length; index++)
        {
            var character = value[index];
            var next = index + 1 < value.Length ? value[index + 1] : '\0';
            if (inString)
            {
                if (character == '\'' && next == '\'')
                {
                    index++;
                }
                else if (character == '\'')
                {
                    inString = false;
                }

                continue;
            }

            if (inBracket)
            {
                if (character == ']' && next == ']')
                {
                    index++;
                }
                else if (character == ']')
                {
                    inBracket = false;
                }

                continue;
            }

            if (character == '\'')
            {
                inString = true;
            }
            else if (character == '[')
            {
                inBracket = true;
            }
            else if (character == '(')
            {
                depth++;
            }
            else if (character == ')' && --depth == 0)
            {
                return index;
            }
        }

        throw new InvalidOperationException("The initial migration contains unbalanced parentheses.");
    }

    private static int FindStatementEnd(string value, int start)
    {
        var depth = 0;
        var inString = false;
        var inBracket = false;

        for (var index = start; index < value.Length; index++)
        {
            var character = value[index];
            var next = index + 1 < value.Length ? value[index + 1] : '\0';
            if (inString)
            {
                if (character == '\'' && next == '\'')
                {
                    index++;
                }
                else if (character == '\'')
                {
                    inString = false;
                }

                continue;
            }

            if (inBracket)
            {
                if (character == ']' && next == ']')
                {
                    index++;
                }
                else if (character == ']')
                {
                    inBracket = false;
                }

                continue;
            }

            switch (character)
            {
                case '\'':
                    inString = true;
                    break;
                case '[':
                    inBracket = true;
                    break;
                case '(':
                    depth++;
                    break;
                case ')':
                    depth--;
                    break;
                case ';' when depth == 0:
                    return index;
            }
        }

        throw new InvalidOperationException("The initial migration contains an unterminated statement.");
    }

    [GeneratedRegex(
        @"CREATE TABLE \[flowpilot\]\.\[(?<table>[^\]]+)\]\s*\(",
        RegexOptions.CultureInvariant)]
    private static partial Regex CreateTableRegex();

    [GeneratedRegex(
        @"ALTER TABLE \[flowpilot\]\.\[(?<table>[^\]]+)\]\s+ADD (?<constraint>CONSTRAINT [\s\S]*?);",
        RegexOptions.CultureInvariant)]
    private static partial Regex AlterTableConstraintRegex();

    [GeneratedRegex(
        @"^\[(?<name>[^\]]+)\]\s+(?<type>[a-zA-Z0-9_]+(?:\s*\([^\)]*\))?)(?:\s+COLLATE\s+(?<collation>[a-zA-Z0-9_]+))?\s+(?<nullability>NOT NULL|NULL)\b",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex ColumnRegex();

    [GeneratedRegex(
        @"\bSET\s+ANSI_PADDING\s+(?<value>ON|OFF)\s*;",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex AnsiPaddingRegex();

    [GeneratedRegex(
        @"^CONSTRAINT \[(?<name>[^\]]+)\]\s+(?<kind>PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY)\b",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex ConstraintHeaderRegex();

    [GeneratedRegex(
        @"^CONSTRAINT \[[^\]]+\]\s+FOREIGN KEY\s*\((?<parentColumns>[^\)]*)\)\s+REFERENCES\s+\[(?<referencedSchema>[^\]]+)\]\.\[(?<referencedTable>[^\]]+)\]\s*\((?<referencedColumns>[^\)]*)\)(?:\s+ON DELETE\s+(?<deleteAction>NO ACTION|CASCADE|SET NULL|SET DEFAULT))?(?:\s+ON UPDATE\s+(?<updateAction>NO ACTION|CASCADE|SET NULL|SET DEFAULT))?\s*$",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex ForeignKeyRegex();

    [GeneratedRegex(
        @"^CONSTRAINT \[[^\]]+\]\s+(?:PRIMARY KEY|UNIQUE)(?:\s+(?<indexType>CLUSTERED|NONCLUSTERED))?\s*\((?<columns>[\s\S]*)\)\s*$",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex KeyConstraintRegex();

    [GeneratedRegex(
        @"^CREATE\s+(?<unique>UNIQUE\s+)?(?:(?<indexType>CLUSTERED|NONCLUSTERED)\s+)?INDEX\s+\[(?<name>[^\]]+)\]\s+ON\s+\[flowpilot\]\.\[(?<table>[^\]]+)\]\s*\(",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase | RegexOptions.Multiline)]
    private static partial Regex CreateIndexRegex();

    [GeneratedRegex(
        @"^CREATE\s+(?<unique>UNIQUE\s+)?(?:(?<indexType>CLUSTERED|NONCLUSTERED)\s+)?INDEX\s+\[(?<name>[^\]]+)\]\s+ON\s+\[flowpilot\]\.\[(?<table>[^\]]+)\]\s*\(",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex IndexHeaderRegex();

    [GeneratedRegex(
        @"\bINCLUDE\s*\(",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex IncludeRegex();

    [GeneratedRegex(
        @"\bWHERE\s+(?<definition>[\s\S]*?)\s*;\s*$",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex WhereRegex();

    [GeneratedRegex(
        @"^\[(?<name>[^\]]+)\](?:\s+(?<direction>ASC|DESC))?\s*$",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex IndexColumnRegex();

    [GeneratedRegex(
        @"^\[(?<name>[^\]]+)\]\s*$",
        RegexOptions.CultureInvariant)]
    private static partial Regex BracketedNameRegex();

    [GeneratedRegex(
        @"EXEC\(N'(?<body>(?:''|[^'])*)'\);",
        RegexOptions.CultureInvariant)]
    private static partial Regex DynamicSqlRegex();

    [GeneratedRegex(
        @"^\s*CREATE TRIGGER \[flowpilot\]\.\[(?<name>[^\]]+)\]\s+ON \[flowpilot\]\.\[(?<table>[^\]]+)\]\s+(?<kind>AFTER|INSTEAD OF)\s+(?<events>[A-Z,\s]+?)\s+AS\b",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex TriggerHeaderRegex();
}

public sealed record InitialSchemaDdlInventory(
    IReadOnlySet<string> Tables,
    IReadOnlySet<string> Columns,
    IReadOnlySet<string> Constraints,
    IReadOnlySet<string> Indexes,
    IReadOnlySet<string> Triggers,
    IReadOnlySet<string> ColumnSignatures,
    IReadOnlySet<string> CheckConstraintSignatures,
    IReadOnlySet<string> ForeignKeySignatures,
    IReadOnlySet<string> KeyConstraintSignatures,
    IReadOnlySet<string> IndexSignatures,
    IReadOnlySet<string> TriggerSignatures);
