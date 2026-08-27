namespace FlowPilot.Database.Migrations;

public sealed class DatabaseMigrationException : InvalidOperationException
{
    public DatabaseMigrationException(DatabaseMigrationFailure failure)
        : base($"Database migration failed ({failure}).")
    {
        Failure = failure;
    }

    public DatabaseMigrationException(
        DatabaseMigrationFailure failure,
        Exception innerException)
        : base($"Database migration failed ({failure}).", innerException)
    {
        ArgumentNullException.ThrowIfNull(innerException);
        Failure = failure;
    }

    public DatabaseMigrationFailure Failure { get; }
}
