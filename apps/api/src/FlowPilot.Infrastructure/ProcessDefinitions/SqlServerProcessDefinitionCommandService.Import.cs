using System.Data;
using System.Text.Json;
using FlowPilot.Application.ProcessDefinitions;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FlowPilot.Infrastructure.ProcessDefinitions;

public sealed partial class SqlServerProcessDefinitionCommandService
{
    private const string ImportRouteScope = "POST /process-definitions/imports";

    public async Task<ProcessDefinitionCommandResult<ImportProcessDefinitionCommandValue>> ImportAsync(
        ImportProcessDefinitionRequest request,
        ProcessDefinitionMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(actor);
        var requestHash = HashRequest(
            $"{ImportRouteScope}\n{request.Document.ToJsonString(JsonOptions)}");
        var reservation = await ReserveIdempotencyAsync<ImportProcessDefinitionCommandValue>(
            actor.EffectiveUserId,
            ImportRouteScope,
            idempotencyKey,
            requestHash,
            cancellationToken).ConfigureAwait(false);
        if (reservation.ReplayValue is not null)
        {
            return Succeeded(reservation.ReplayValue with { Replayed = true });
        }

        if (reservation.Failure is not null)
        {
            return Failed<ImportProcessDefinitionCommandValue>(reservation.Failure);
        }

        await using var transaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            ProcessDefinitionTransferMapper.ImportedDefinition imported;
            try
            {
                var references = await LoadTransferReferenceNamesAsync(cancellationToken)
                    .ConfigureAwait(false);
                imported = ProcessDefinitionTransferMapper.Import(request.Document, references);
            }
            catch (InvalidDataException exception)
            {
                var failure = ValidationFailure(
                    "流程定义导入文件无效",
                    [InputIssue("document", "INVALID_DOCUMENT", exception.Message)]);
                await CompleteIdempotencyFailureInCurrentTransactionAsync(
                    reservation,
                    failure,
                    traceId,
                    cancellationToken).ConfigureAwait(false);
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return Failed<ImportProcessDefinitionCommandValue>(failure);
            }

            if (imported.Name.Length > 100)
            {
                var failure = ValidationFailure(
                    "流程定义导入文件无效",
                    [InputIssue("document.流程定义.名称", "MAX_LENGTH", "流程名称不能超过 100 个字符。")]);
                await CompleteIdempotencyFailureInCurrentTransactionAsync(
                    reservation,
                    failure,
                    traceId,
                    cancellationToken).ConfigureAwait(false);
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return Failed<ImportProcessDefinitionCommandValue>(failure);
            }

            var importedName = await CreateAvailableImportNameAsync(imported.Name, cancellationToken)
                .ConfigureAwait(false);
            var now = UtcNow();
            var definitionId = Guid.NewGuid();
            var code = CreateDefinitionCode(imported.Type, definitionId);
            var definition = new RuntimeWorkflowDefinition
            {
                Id = definitionId,
                Code = code,
                NormalizedCode = code.ToUpperInvariant(),
                Name = importedName,
                Description = imported.Description,
                Type = imported.Type,
                IsDisabled = false,
                PublishedVersionId = null,
                NextVersionNumber = imported.Versions.Max(version => version.VersionNumber) + 1,
                InstanceCount = 0,
                Revision = 1,
                CreatedAt = now.UtcDateTime,
                UpdatedAt = now.UtcDateTime,
                CreatedBy = actor.EffectiveUserId,
                UpdatedBy = actor.EffectiveUserId,
            };
            _dbContext.RuntimeWorkflowDefinitions.Add(definition);

            var catalog = await LoadReferenceCatalogAsync(cancellationToken).ConfigureAwait(false);
            var persistedVersions = new List<(RuntimeWorkflowVersion Entity, ProcessBasicConfigInput Basic, System.Text.Json.Nodes.JsonObject Snapshot)>();
            foreach (var importedVersion in imported.Versions)
            {
                var basic = NormalizeBasic(importedVersion.Basic with { Name = importedName, Type = imported.Type });
                var snapshot = importedVersion.Snapshot;
                var validation = ValidateVersion(basic, snapshot, catalog, now);
                var entity = new RuntimeWorkflowVersion
                {
                    Id = Guid.NewGuid(),
                    DefinitionId = definitionId,
                    VersionNumber = importedVersion.VersionNumber,
                    VersionLabel = importedVersion.VersionLabel,
                    BasicJson = SerializeNode(CreateBasicNode(basic)),
                    SnapshotJson = SerializeNode(snapshot),
                    ValidationStatus = validation.Status,
                    ValidationJson = SerializeValidation(validation),
                    ValidatedAt = now.UtcDateTime,
                    InstanceCount = 0,
                    Revision = 1,
                    CreatedAt = now.UtcDateTime,
                    CreatedBy = actor.EffectiveUserId,
                    UpdatedAt = now.UtcDateTime,
                    UpdatedBy = actor.EffectiveUserId,
                    ChangeNote = string.IsNullOrWhiteSpace(importedVersion.ChangeNote)
                        ? "从导入文件创建"
                        : importedVersion.ChangeNote.Trim(),
                };
                _dbContext.RuntimeWorkflowVersions.Add(entity);
                persistedVersions.Add((entity, basic, snapshot));
            }

            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            foreach (var version in persistedVersions)
            {
                await ReplaceReferencesAsync(
                    version.Entity.Id,
                    version.Basic,
                    version.Snapshot,
                    cancellationToken).ConfigureAwait(false);
                await ReplaceFieldCatalogAsync(
                    version.Entity.Id,
                    version.Snapshot,
                    cancellationToken).ConfigureAwait(false);
            }

            AddLifecycleAudit(
                "process-definition",
                definitionId,
                "import",
                ["definition", "versions"],
                actor,
                traceId,
                now);
            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            var value = new ImportProcessDefinitionCommandValue(definitionId, 1, false);
            await CompleteIdempotencySuccessAsync(
                reservation,
                201,
                1,
                value,
                $"/api/flowpilot/v1/process-definitions/{definitionId:D}",
                now,
                cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return Succeeded(value);
        }
        catch
        {
            await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            throw;
        }
    }

    private async Task<ProcessDefinitionTransferMapper.ReferenceNames> LoadTransferReferenceNamesAsync(
        CancellationToken cancellationToken)
    {
        var groups = await _dbContext.RuntimeWorkflowGroups
            .AsNoTracking()
            .ToDictionaryAsync(item => item.Id, item => item.Name, cancellationToken)
            .ConfigureAwait(false);
        var roles = await _dbContext.RuntimeRoles
            .AsNoTracking()
            .Where(item => !item.IsBuiltIn)
            .ToDictionaryAsync(item => item.Id, item => item.Name, cancellationToken)
            .ConfigureAwait(false);
        var users = await _dbContext.OrganizationUserReferences
            .AsNoTracking()
            .Where(item => !item.IsBuiltInSuperAdmin)
            .ToDictionaryAsync(item => item.Id, item => item.DisplayName, cancellationToken)
            .ConfigureAwait(false);
        return new ProcessDefinitionTransferMapper.ReferenceNames(groups, roles, users);
    }

    private async Task<string> CreateAvailableImportNameAsync(
        string sourceName,
        CancellationToken cancellationToken)
    {
        var names = await _dbContext.RuntimeWorkflowDefinitions
            .AsNoTracking()
            .Select(item => item.Name)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        if (!names.Contains(sourceName, StringComparer.Ordinal)) return sourceName;

        const string suffix = "（导入）";
        var baseName = sourceName.Length + suffix.Length <= 100
            ? sourceName
            : sourceName[..(100 - suffix.Length)];
        var candidate = $"{baseName}{suffix}";
        if (!names.Contains(candidate, StringComparer.Ordinal)) return candidate;

        for (var sequence = 2; ; sequence++)
        {
            var numberedSuffix = $"（导入 {sequence}）";
            baseName = sourceName.Length + numberedSuffix.Length <= 100
                ? sourceName
                : sourceName[..(100 - numberedSuffix.Length)];
            candidate = $"{baseName}{numberedSuffix}";
            if (!names.Contains(candidate, StringComparer.Ordinal)) return candidate;
        }
    }
}
