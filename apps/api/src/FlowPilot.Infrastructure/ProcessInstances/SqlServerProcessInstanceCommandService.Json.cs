using System.Globalization;
using System.Text.Json.Nodes;

namespace FlowPilot.Infrastructure.ProcessInstances;

public sealed partial class SqlServerProcessInstanceCommandService
{
    private static JsonObject[] ReadFormFields(JsonObject snapshot) =>
        snapshot["form"]?["fields"] is JsonArray fields
            ? fields.OfType<JsonObject>().ToArray()
            : [];

    private static JsonObject[] ReadFlowNodes(JsonObject snapshot) =>
        snapshot["flow"]?["nodes"] is JsonArray nodes
            ? nodes.OfType<JsonObject>().ToArray()
            : [];

    private static FlowEdge[] ReadFlowEdges(JsonObject snapshot) =>
        snapshot["flow"]?["edges"] is JsonArray edges
            ? edges.OfType<JsonObject>()
                .Select(edge => new FlowEdge(
                    ReadString(edge, "source") ?? string.Empty,
                    ReadString(edge, "target") ?? string.Empty))
                .Where(edge => edge.Source.Length > 0 && edge.Target.Length > 0)
                .ToArray()
            : [];

    private static NodePlan CreateNodePlan(JsonObject node)
    {
        var data = node["data"] as JsonObject ?? [];
        return new NodePlan(
            ReadRequiredString(node, "id"),
            ReadString(data, "label") ?? "审批",
            Guid.Parse(ReadRequiredString(data, "permissionGroupId")),
            ReadBool(data, "specifyAssignee"),
            ReadString(data, "handlingMode") == "confirmation" ? "confirmation" : "approval",
            ReadStringArray(data, "editableFieldIds"),
            ReadBool(data, "allowRepeatedEditing"),
            data["activationCondition"] as JsonObject);
    }

    private static string ReadRequiredString(JsonObject source, string propertyName) =>
        ReadString(source, propertyName)
        ?? throw new InvalidDataException($"Published process version has no {propertyName}.");

    private static string? ReadString(JsonObject? source, string propertyName) =>
        source?[propertyName] is JsonValue value && value.TryGetValue<string>(out var text)
            ? text
            : null;

    private static bool ReadBool(JsonObject? source, string propertyName) =>
        source?[propertyName] is JsonValue value
        && value.TryGetValue<bool>(out var result)
        && result;

    private static string[] ReadStringArray(JsonObject source, string propertyName) =>
        source[propertyName] is JsonArray values
            ? values
                .Select(value => value?.GetValue<string?>())
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Select(value => value!)
                .Distinct(StringComparer.Ordinal)
                .ToArray()
            : [];

    private static HashSet<Guid> ReadGuidArray(JsonObject source, string propertyName) =>
        source[propertyName] is JsonArray values
            ? values
                .Select(value => Guid.TryParse(value?.GetValue<string?>(), out var id) ? id : Guid.Empty)
                .Where(id => id != Guid.Empty)
                .ToHashSet()
            : [];

    private static bool IsEmpty(JsonNode? value) => value switch
    {
        null => true,
        JsonValue scalar when scalar.TryGetValue<string>(out var text) => string.IsNullOrWhiteSpace(text),
        JsonArray array => array.Count == 0,
        _ => false,
    };

    private static bool ConditionMatches(JsonObject? condition, JsonObject values)
    {
        if (condition?["rules"] is not JsonArray ruleNodes || ruleNodes.Count == 0)
        {
            return true;
        }

        var results = ruleNodes
            .OfType<JsonObject>()
            .Select(rule => RuleMatches(rule, values))
            .ToArray();
        return ReadString(condition, "mode") == "any"
            ? results.Any(result => result)
            : results.All(result => result);
    }

    private static bool RuleMatches(JsonObject rule, JsonObject values)
    {
        var actual = values[ReadString(rule, "fieldId") ?? string.Empty];
        var expected = rule["value"];
        return ReadString(rule, "operator") switch
        {
            "neq" => !JsonNode.DeepEquals(actual, expected),
            "gt" => Compare(actual, expected) > 0,
            "gte" => Compare(actual, expected) >= 0,
            "lt" => Compare(actual, expected) < 0,
            "lte" => Compare(actual, expected) <= 0,
            "contains" => Contains(actual, expected),
            "not-contains" => !Contains(actual, expected),
            "empty" => IsEmpty(actual),
            "not-empty" => !IsEmpty(actual),
            _ => JsonNode.DeepEquals(actual, expected),
        };
    }

    private static int Compare(JsonNode? left, JsonNode? right)
    {
        if (TryDecimal(left, out var leftNumber) && TryDecimal(right, out var rightNumber))
        {
            return leftNumber.CompareTo(rightNumber);
        }

        return string.Compare(
            DisplayValue(left),
            DisplayValue(right),
            StringComparison.Ordinal);
    }

    private static bool Contains(JsonNode? actual, JsonNode? expected)
    {
        if (actual is JsonArray array)
        {
            return array.Any(item => JsonNode.DeepEquals(item, expected));
        }

        return DisplayValue(actual).Contains(DisplayValue(expected), StringComparison.Ordinal);
    }

    private static bool TryDecimal(JsonNode? value, out decimal number)
    {
        if (value is JsonValue scalar && scalar.TryGetValue<decimal>(out number))
        {
            return true;
        }

        return decimal.TryParse(
            DisplayValue(value),
            NumberStyles.Number,
            CultureInfo.InvariantCulture,
            out number);
    }

    private static string DisplayValue(JsonNode? value)
    {
        if (value is null)
        {
            return string.Empty;
        }

        if (value is JsonValue scalar && scalar.TryGetValue<string>(out var text))
        {
            return text;
        }

        return value.ToJsonString();
    }
}
