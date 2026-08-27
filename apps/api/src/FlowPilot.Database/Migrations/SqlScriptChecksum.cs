using System.Security.Cryptography;
using System.Text;

namespace FlowPilot.Database.Migrations;

public static class SqlScriptChecksum
{
    public static string Normalize(string sql)
    {
        ArgumentNullException.ThrowIfNull(sql);

        var normalized = sql.Length > 0 && sql[0] == '\uFEFF'
            ? sql[1..]
            : sql;
        normalized = normalized
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n')
            .TrimEnd('\n');

        return $"{normalized}\n";
    }

    public static string ComputeSha256(string sql)
    {
        var normalized = Normalize(sql);
        var bytes = Encoding.UTF8.GetBytes(normalized);
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }
}
