using System.Globalization;

namespace FlowPilot.Domain.Common;

/// <summary>
/// Represents the positive integer concurrency revision used by mutable aggregates.
/// </summary>
public readonly record struct Revision
{
    public Revision(int value)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(value, 1);
        Value = value;
    }

    public int Value { get; }

    public Revision Next() => new(checked(Value + 1));

    public string ToStrongEntityTag() => $"\"{Value.ToString(CultureInfo.InvariantCulture)}\"";

    public static bool TryParseStrongEntityTag(string? value, out Revision revision)
    {
        revision = default;

        if (string.IsNullOrWhiteSpace(value)
            || value.Length < 3
            || value[0] != '"'
            || value[^1] != '"'
            || value.StartsWith("W/", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var numericValue = value.AsSpan(1, value.Length - 2);
        if (!int.TryParse(numericValue, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)
            || parsed < 1)
        {
            return false;
        }

        revision = new Revision(parsed);
        return true;
    }
}
