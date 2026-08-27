using System.Data;
using FlowPilot.Infrastructure.Configuration;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.Health;

public sealed class SqlServerBuiltinSeedVersionReader : IBuiltinSeedVersionReader
{
    private const string BuiltinSeedVersionQuery = """
        SELECT [state_value]
        FROM [flowpilot].[system_state]
        WHERE [state_key] COLLATE Latin1_General_100_BIN2 = N'builtin-seed';
        """;

    private readonly FlowPilotDbContext _dbContext;
    private readonly FlowPilotDatabaseOptions _databaseOptions;

    public SqlServerBuiltinSeedVersionReader(FlowPilotDbContext dbContext)
        : this(dbContext, FlowPilotDatabaseOptions.Default)
    {
    }

    public SqlServerBuiltinSeedVersionReader(
        FlowPilotDbContext dbContext,
        FlowPilotDatabaseOptions databaseOptions)
    {
        ArgumentNullException.ThrowIfNull(dbContext);
        ArgumentNullException.ThrowIfNull(databaseOptions);
        _dbContext = dbContext;
        _databaseOptions = databaseOptions;
    }

    public async Task<string?> ReadAsync(CancellationToken cancellationToken = default)
    {
        var connection = _dbContext.Database.GetDbConnection();
        var shouldCloseConnection = connection.State != ConnectionState.Open;

        if (shouldCloseConnection)
        {
            await _dbContext.Database.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        }

        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = BuiltinSeedVersionQuery;
            command.CommandTimeout = _databaseOptions.ReadinessCommandTimeoutSeconds;

            var value = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
            return value is null or DBNull
                ? null
                : Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
        }
        finally
        {
            if (shouldCloseConnection)
            {
                await _dbContext.Database.CloseConnectionAsync().ConfigureAwait(false);
            }
        }
    }
}
