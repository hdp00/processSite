using System.Security.Cryptography;
using System.Text;

namespace FlowPilot.Infrastructure.Persistence.Schema;

public static class SqlDefinitionFingerprint
{
    public static string ComputeExpression(string definition)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(definition);

        var tokens = Tokenize(definition);
        RemoveTrailingSemicolons(tokens);
        var nodes = ParseNodes(tokens);
        var normalizedTokens = new List<string>(tokens.Count);
        AppendNodes(nodes, normalizedTokens, isRoot: true);
        return ComputeHash(normalizedTokens);
    }

    public static string ComputeModule(string definition)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(definition);

        var tokens = Tokenize(definition);
        RemoveTrailingSemicolons(tokens);
        return ComputeHash(tokens);
    }

    private static string ComputeHash(IEnumerable<string> tokens)
    {
        var canonical = string.Join('\u001f', tokens);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)))
            .ToLowerInvariant();
    }

    private static List<string> Tokenize(string definition)
    {
        var tokens = new List<string>();

        for (var index = 0; index < definition.Length;)
        {
            var character = definition[index];
            if (char.IsWhiteSpace(character))
            {
                index++;
                continue;
            }

            if (character == '-' && Peek(definition, index + 1) == '-')
            {
                index += 2;
                while (index < definition.Length && definition[index] is not '\r' and not '\n')
                {
                    index++;
                }

                continue;
            }

            if (character == '/' && Peek(definition, index + 1) == '*')
            {
                index = SkipBlockComment(definition, index + 2);
                continue;
            }

            if ((character is 'N' or 'n') && Peek(definition, index + 1) == '\'')
            {
                var (token, nextIndex) = ReadQuotedToken(definition, index + 1, '\'', "n");
                tokens.Add(token);
                index = nextIndex;
                continue;
            }

            if (character == '\'')
            {
                var (token, nextIndex) = ReadQuotedToken(definition, index, '\'', string.Empty);
                tokens.Add(token);
                index = nextIndex;
                continue;
            }

            if (character == '[')
            {
                var (token, nextIndex) = ReadQuotedToken(definition, index, ']', string.Empty);
                tokens.Add(token);
                index = nextIndex;
                continue;
            }

            if (IsWordStart(character))
            {
                var start = index++;
                while (index < definition.Length && IsWordPart(definition[index]))
                {
                    index++;
                }

                tokens.Add(definition[start..index].ToLowerInvariant());
                continue;
            }

            if (char.IsAsciiDigit(character))
            {
                var start = index++;
                while (index < definition.Length &&
                    (char.IsAsciiDigit(definition[index]) || definition[index] == '.'))
                {
                    index++;
                }

                tokens.Add(definition[start..index]);
                continue;
            }

            var twoCharacterOperator = index + 1 < definition.Length
                ? definition.Substring(index, 2)
                : string.Empty;
            if (twoCharacterOperator is "<>" or "<=" or ">=" or "!=" or "!<" or "!>")
            {
                tokens.Add(twoCharacterOperator);
                index += 2;
                continue;
            }

            tokens.Add(character.ToString());
            index++;
        }

        return tokens;
    }

    private static int SkipBlockComment(string definition, int index)
    {
        var depth = 1;
        while (index < definition.Length && depth > 0)
        {
            if (definition[index] == '/' && Peek(definition, index + 1) == '*')
            {
                depth++;
                index += 2;
            }
            else if (definition[index] == '*' && Peek(definition, index + 1) == '/')
            {
                depth--;
                index += 2;
            }
            else
            {
                index++;
            }
        }

        if (depth != 0)
        {
            throw new ArgumentException("The SQL definition contains an unterminated comment.", nameof(definition));
        }

        return index;
    }

    private static (string Token, int NextIndex) ReadQuotedToken(
        string definition,
        int start,
        char terminator,
        string prefix)
    {
        var opening = definition[start];
        var builder = new StringBuilder(prefix).Append(opening);

        for (var index = start + 1; index < definition.Length; index++)
        {
            var character = definition[index];
            builder.Append(character);
            if (character != terminator)
            {
                continue;
            }

            if (Peek(definition, index + 1) == terminator)
            {
                builder.Append(terminator);
                index++;
                continue;
            }

            return (builder.ToString(), index + 1);
        }

        throw new ArgumentException("The SQL definition contains an unterminated quoted token.", nameof(definition));
    }

    private static List<TokenNode> ParseNodes(List<string> tokens)
    {
        var index = 0;
        var nodes = ParseNodes(tokens, ref index, stopAtClosingParenthesis: false);
        if (index != tokens.Count)
        {
            throw new ArgumentException("The SQL definition contains unbalanced parentheses.", nameof(tokens));
        }

        return nodes;
    }

    private static List<TokenNode> ParseNodes(
        IReadOnlyList<string> tokens,
        ref int index,
        bool stopAtClosingParenthesis)
    {
        var nodes = new List<TokenNode>();
        while (index < tokens.Count)
        {
            var token = tokens[index++];
            if (token == "(")
            {
                nodes.Add(new GroupNode(ParseNodes(tokens, ref index, stopAtClosingParenthesis: true)));
            }
            else if (token == ")")
            {
                if (!stopAtClosingParenthesis)
                {
                    throw new ArgumentException(
                        "The SQL definition contains unbalanced parentheses.",
                        nameof(tokens));
                }

                return nodes;
            }
            else
            {
                nodes.Add(new LeafNode(token));
            }
        }

        if (stopAtClosingParenthesis)
        {
            throw new ArgumentException("The SQL definition contains unbalanced parentheses.", nameof(tokens));
        }

        return nodes;
    }

    private static void AppendNodes(
        IReadOnlyList<TokenNode> nodes,
        ICollection<string> destination,
        bool isRoot)
    {
        for (var index = 0; index < nodes.Count; index++)
        {
            var node = nodes[index];
            if (node is LeafNode leaf)
            {
                destination.Add(leaf.Value);
                continue;
            }

            var group = (GroupNode)node;
            var previousToken = index > 0 && nodes[index - 1] is LeafNode previousLeaf
                ? previousLeaf.Value
                : null;
            var canDiscardParentheses =
                (isRoot && nodes.Count == 1) ||
                (IsAtomic(group.Children) && !IsCallOrListPrefix(previousToken));

            if (!canDiscardParentheses)
            {
                destination.Add("(");
            }

            AppendNodes(
                group.Children,
                destination,
                isRoot: isRoot && nodes.Count == 1 && canDiscardParentheses);

            if (!canDiscardParentheses)
            {
                destination.Add(")");
            }
        }
    }

    private static bool IsAtomic(IReadOnlyList<TokenNode> nodes) =>
        nodes.Count == 1 &&
        (nodes[0] is LeafNode ||
            nodes[0] is GroupNode group && IsAtomic(group.Children));

    private static bool IsCallOrListPrefix(string? token) =>
        token is not null &&
        (token == "in" || token == "values" || token == "over" || IsWordToken(token));

    private static bool IsWordToken(string token) =>
        token.Length > 0 && IsWordStart(token[0]) && token.All(IsWordPart);

    private static bool IsWordStart(char character) =>
        char.IsAsciiLetter(character) || character is '_' or '@' or '#' or '$';

    private static bool IsWordPart(char character) =>
        IsWordStart(character) || char.IsAsciiDigit(character);

    private static char Peek(string value, int index) =>
        index < value.Length ? value[index] : '\0';

    private static void RemoveTrailingSemicolons(List<string> tokens)
    {
        while (tokens.Count > 0 && tokens[^1] == ";")
        {
            tokens.RemoveAt(tokens.Count - 1);
        }
    }

    private abstract record TokenNode;

    private sealed record LeafNode(string Value) : TokenNode;

    private sealed record GroupNode(IReadOnlyList<TokenNode> Children) : TokenNode;
}
