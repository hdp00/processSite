using System.Text.RegularExpressions;

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

        foreach (Match match in CreateTableRegex().Matches(sql))
        {
            var table = match.Groups["table"].Value;
            _ = tables.Add(table);
            var openingParenthesis = match.Index + match.Length - 1;
            var closingParenthesis = FindMatchingParenthesis(sql, openingParenthesis);
            var body = sql[(openingParenthesis + 1)..closingParenthesis];

            foreach (var item in SplitTopLevel(body))
            {
                var column = ColumnHeaderRegex().Match(item);
                if (column.Success)
                {
                    _ = columns.Add($"{table}.{column.Groups["name"].Value}");
                    continue;
                }

                AddConstraint(table, item, constraints);
            }
        }

        foreach (Match match in AlterTableConstraintRegex().Matches(sql))
        {
            AddConstraint(
                match.Groups["table"].Value,
                match.Groups["constraint"].Value,
                constraints);
        }

        foreach (Match match in CreateIndexRegex().Matches(sql))
        {
            _ = indexes.Add($"{match.Groups["table"].Value}.{match.Groups["name"].Value}");
        }

        foreach (Match match in DynamicSqlRegex().Matches(sql))
        {
            var definition = match.Groups["body"].Value
                .Replace("''", "'", StringComparison.Ordinal);
            var trigger = TriggerHeaderRegex().Match(definition);
            if (trigger.Success)
            {
                _ = triggers.Add(
                    $"{trigger.Groups["table"].Value}.{trigger.Groups["name"].Value}");
            }
        }

        return new InitialSchemaDdlInventory(
            tables,
            columns,
            constraints,
            indexes,
            triggers);
    }

    private static void AddConstraint(
        string table,
        string item,
        HashSet<string> constraints)
    {
        var match = ConstraintHeaderRegex().Match(item.Trim());
        if (match.Success)
        {
            _ = constraints.Add($"{table}.{match.Groups["name"].Value}");
        }
    }

    private static string[] SplitTopLevel(string value)
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
        return items.Where(item => item.Length > 0).ToArray();
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

    [GeneratedRegex(
        @"CREATE TABLE \[flowpilot\]\.\[(?<table>[^\]]+)\]\s*\(",
        RegexOptions.CultureInvariant)]
    private static partial Regex CreateTableRegex();

    [GeneratedRegex(
        @"ALTER TABLE \[flowpilot\]\.\[(?<table>[^\]]+)\]\s+ADD (?<constraint>CONSTRAINT [\s\S]*?);",
        RegexOptions.CultureInvariant)]
    private static partial Regex AlterTableConstraintRegex();

    [GeneratedRegex(
        @"^\[(?<name>[^\]]+)\]\s+",
        RegexOptions.CultureInvariant)]
    private static partial Regex ColumnHeaderRegex();

    [GeneratedRegex(
        @"^CONSTRAINT \[(?<name>[^\]]+)\]\s+",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex ConstraintHeaderRegex();

    [GeneratedRegex(
        @"^CREATE\s+(?:UNIQUE\s+)?(?:(?:CLUSTERED|NONCLUSTERED)\s+)?INDEX\s+\[(?<name>[^\]]+)\]\s+ON\s+\[flowpilot\]\.\[(?<table>[^\]]+)\]",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase | RegexOptions.Multiline)]
    private static partial Regex CreateIndexRegex();

    [GeneratedRegex(
        @"EXEC\(N'(?<body>(?:''|[^'])*)'\);",
        RegexOptions.CultureInvariant)]
    private static partial Regex DynamicSqlRegex();

    [GeneratedRegex(
        @"^\s*CREATE TRIGGER \[flowpilot\]\.\[(?<name>[^\]]+)\]\s+ON \[flowpilot\]\.\[(?<table>[^\]]+)\]",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex TriggerHeaderRegex();
}

public sealed record InitialSchemaDdlInventory(
    IReadOnlySet<string> Tables,
    IReadOnlySet<string> Columns,
    IReadOnlySet<string> Constraints,
    IReadOnlySet<string> Indexes,
    IReadOnlySet<string> Triggers);
