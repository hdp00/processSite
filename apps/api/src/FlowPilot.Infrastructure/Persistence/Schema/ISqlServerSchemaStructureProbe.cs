using System.Data.Common;

namespace FlowPilot.Infrastructure.Persistence.Schema;

public interface ISqlServerSchemaStructureProbe
{
    Task<SqlServerSchemaValidationResult> ValidateAsync(
        DbConnection connection,
        DbTransaction? transaction = null,
        CancellationToken cancellationToken = default);
}
