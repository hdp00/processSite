using System.Data;
using System.Text.Json;
using FlowPilot.Application.Organization;
using FlowPilot.Application.Security;
using FlowPilot.Infrastructure.Persistence;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace FlowPilot.Infrastructure.Organization;

public sealed partial class SqlServerOrganizationService
{
    private const string CreateDepartmentRouteScope = "POST:/departments";
    private const string CreatePositionRouteScope = "POST:/positions";

    public Task<DepartmentDto?> GetDepartmentAsync(
        Guid departmentId,
        CancellationToken cancellationToken = default) =>
        LoadDepartmentAsync(departmentId, cancellationToken);

    public Task<PositionDto?> GetPositionAsync(
        Guid positionId,
        CancellationToken cancellationToken = default) =>
        LoadPositionAsync(positionId, cancellationToken);

    public async Task<OrganizationCommandResult<DepartmentDto>> CreateDepartmentAsync(
        UpsertDepartmentRequest request,
        WorkflowGroupMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);

        var normalized = NormalizeDepartment(
            request.Name,
            request.ParentId,
            request.SortOrder,
            request.Status,
            request.Description);
        if (normalized.Failure is not null)
        {
            return Failed<DepartmentDto>(normalized.Failure);
        }

        var input = normalized.Value!;
        var requestHash = HashRequest(JsonSerializer.Serialize(input, JsonOptions));
        var now = _timeProvider.GetUtcNow();
        await using var databaseTransaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        var (connection, transaction) = GetSqlTransaction(databaseTransaction);

        var existing = await LoadIdempotencyAsync(
            connection,
            transaction,
            actor.EffectiveUserId,
            CreateDepartmentRouteScope,
            idempotencyKey,
            cancellationToken).ConfigureAwait(false);
        var replay = ReplayOrFailure<DepartmentDto>(existing, requestHash);
        if (replay is not null)
        {
            await databaseTransaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return replay;
        }

        var validation = await ValidateDepartmentAsync(
            departmentId: null,
            currentParentId: null,
            input,
            cancellationToken).ConfigureAwait(false);
        if (validation.Failure is not null)
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<DepartmentDto>(validation.Failure);
        }

        var departmentId = Guid.NewGuid();
        var code = CreateCode("DEPT", departmentId, 17);
        var idempotencyId = Guid.NewGuid();
        await InsertIdempotencyAsync(
            connection,
            transaction,
            idempotencyId,
            actor.EffectiveUserId,
            CreateDepartmentRouteScope,
            idempotencyKey,
            requestHash,
            now,
            cancellationToken).ConfigureAwait(false);

        _dbContext.Departments.Add(new DepartmentEntity
        {
            Id = departmentId,
            Code = code,
            NormalizedCode = code,
            Name = input.Name,
            ParentId = input.ParentId,
            Path = BuildDepartmentPath(validation.ParentPath, input.Name),
            SortOrder = input.SortOrder,
            IsEnabled = input.IsEnabled,
            Description = input.Description,
            Revision = 1,
            CreatedAt = now.UtcDateTime,
            UpdatedAt = now.UtcDateTime,
            CreatedBy = actor.EffectiveUserId,
            UpdatedBy = actor.EffectiveUserId,
        });
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        await InsertOrganizationAuditAsync(
            connection,
            transaction,
            "department",
            departmentId,
            "department.created",
            ["name", "parentId", "sortOrder", "status", "description"],
            actor,
            traceId,
            now,
            cancellationToken).ConfigureAwait(false);
        var created = await LoadDepartmentAsync(departmentId, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException("创建后的部门无法重新读取。");
        await CompleteIdempotencyAsync(
            connection,
            transaction,
            idempotencyId,
            created,
            created.Revision,
            $"/departments/{created.Id:D}",
            now,
            cancellationToken).ConfigureAwait(false);
        await databaseTransaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return Succeeded(created);
    }

    public async Task<OrganizationCommandResult<DepartmentDto>> UpdateDepartmentAsync(
        Guid departmentId,
        UpdateDepartmentRequest request,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!request.HasChanges)
        {
            return Failed<DepartmentDto>(ReferenceDataValidationFailure(
                "部门校验失败",
                [Issue("request", "MIN_PROPERTIES", "至少提供一个需要修改的字段。")]));
        }

        var now = _timeProvider.GetUtcNow();
        await using var databaseTransaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        var (connection, transaction) = GetSqlTransaction(databaseTransaction);
        var department = await _dbContext.Departments
            .SingleOrDefaultAsync(item => item.Id == departmentId, cancellationToken)
            .ConfigureAwait(false);
        if (department is null)
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<DepartmentDto>(DepartmentNotFoundFailure());
        }

        if (department.Revision != expectedRevision)
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<DepartmentDto>(RevisionFailure("部门", department.Revision));
        }

        var children = await _dbContext.Departments
            .Where(item => item.ParentId == departmentId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var parentId = request.ParentIdSpecified ? request.ParentId : department.ParentId;
        var normalized = NormalizeDepartment(
            request.Name ?? department.Name,
            parentId,
            request.SortOrder ?? department.SortOrder,
            request.Status ?? ToStatus(department.IsEnabled),
            request.Description ?? department.Description);
        if (normalized.Failure is not null)
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<DepartmentDto>(normalized.Failure);
        }

        var input = normalized.Value!;
        if (input.ParentId == departmentId)
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<DepartmentDto>(ReferenceDataValidationFailure(
                "部门校验失败",
                [Issue("parentId", "INVALID_REFERENCE", "部门不能将自己设为上级部门。")]));
        }

        if (children.Count > 0 && input.ParentId is not null && input.ParentId != department.ParentId)
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<DepartmentDto>(Failure(
                OrganizationCommandError.Conflict,
                "DEPARTMENT_HAS_CHILDREN",
                "部门仍有下级部门",
                "包含下级部门的一级部门不能移动到其他部门下。"));
        }

        var validation = await ValidateDepartmentAsync(
            departmentId,
            department.ParentId,
            input,
            cancellationToken).ConfigureAwait(false);
        if (validation.Failure is not null)
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<DepartmentDto>(validation.Failure);
        }

        var path = BuildDepartmentPath(validation.ParentPath, input.Name);
        department.Name = input.Name;
        department.ParentId = input.ParentId;
        department.Path = path;
        department.SortOrder = input.SortOrder;
        department.IsEnabled = input.IsEnabled;
        department.Description = input.Description;
        Touch(department, actor.EffectiveUserId, now);

        foreach (var child in children.Where(child => child.Path != $"{path} / {child.Name}"))
        {
            child.Path = $"{path} / {child.Name}";
            Touch(child, actor.EffectiveUserId, now);
        }

        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await InsertOrganizationAuditAsync(
            connection,
            transaction,
            "department",
            departmentId,
            "department.updated",
            GetChangedFields(request),
            actor,
            traceId,
            now,
            cancellationToken).ConfigureAwait(false);
        var updated = await LoadDepartmentAsync(departmentId, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException("更新后的部门无法重新读取。");
        await databaseTransaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return Succeeded(updated);
    }

    public async Task<OrganizationCommandResult<bool>> DeleteDepartmentAsync(
        Guid departmentId,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        var now = _timeProvider.GetUtcNow();
        await using var databaseTransaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        var (connection, transaction) = GetSqlTransaction(databaseTransaction);
        var department = await _dbContext.Departments
            .SingleOrDefaultAsync(item => item.Id == departmentId, cancellationToken)
            .ConfigureAwait(false);
        if (department is null)
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<bool>(DepartmentNotFoundFailure());
        }

        if (department.Revision != expectedRevision)
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<bool>(RevisionFailure("部门", department.Revision));
        }

        var isInUse = await _dbContext.OrganizationUserReferences
                .AnyAsync(user => user.DepartmentId == departmentId, cancellationToken)
                .ConfigureAwait(false)
            || await _dbContext.Departments
                .AnyAsync(item => item.ParentId == departmentId, cancellationToken)
                .ConfigureAwait(false);
        if (isInUse)
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<bool>(Failure(
                OrganizationCommandError.Conflict,
                "DEPARTMENT_IN_USE",
                "部门正在使用",
                "请先移走部门成员并删除所有下级部门。"));
        }

        await InsertOrganizationAuditAsync(
            connection,
            transaction,
            "department",
            departmentId,
            "department.deleted",
            ["department"],
            actor,
            traceId,
            now,
            cancellationToken).ConfigureAwait(false);
        _dbContext.Departments.Remove(department);
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await databaseTransaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return Succeeded(true);
    }

    public async Task<OrganizationCommandResult<PositionDto>> CreatePositionAsync(
        UpsertPositionRequest request,
        WorkflowGroupMutationActor actor,
        string idempotencyKey,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);

        var normalized = NormalizePosition(request.Name, request.SortOrder, request.Status, request.Description);
        if (normalized.Failure is not null)
        {
            return Failed<PositionDto>(normalized.Failure);
        }

        var input = normalized.Value!;
        var requestHash = HashRequest(JsonSerializer.Serialize(input, JsonOptions));
        var now = _timeProvider.GetUtcNow();
        await using var databaseTransaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        var (connection, transaction) = GetSqlTransaction(databaseTransaction);

        var existing = await LoadIdempotencyAsync(
            connection,
            transaction,
            actor.EffectiveUserId,
            CreatePositionRouteScope,
            idempotencyKey,
            cancellationToken).ConfigureAwait(false);
        var replay = ReplayOrFailure<PositionDto>(existing, requestHash);
        if (replay is not null)
        {
            await databaseTransaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return replay;
        }

        if (await PositionNameExistsAsync(input.NormalizedName, null, cancellationToken).ConfigureAwait(false))
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<PositionDto>(PositionNameConflictFailure());
        }

        var positionId = Guid.NewGuid();
        var code = CreateCode("POS", positionId, 16);
        var idempotencyId = Guid.NewGuid();
        await InsertIdempotencyAsync(
            connection,
            transaction,
            idempotencyId,
            actor.EffectiveUserId,
            CreatePositionRouteScope,
            idempotencyKey,
            requestHash,
            now,
            cancellationToken).ConfigureAwait(false);

        _dbContext.Positions.Add(new PositionEntity
        {
            Id = positionId,
            Code = code,
            NormalizedCode = code,
            Name = input.Name,
            NormalizedName = input.NormalizedName,
            SortOrder = input.SortOrder,
            IsEnabled = input.IsEnabled,
            Description = input.Description,
            Revision = 1,
            CreatedAt = now.UtcDateTime,
            UpdatedAt = now.UtcDateTime,
            CreatedBy = actor.EffectiveUserId,
            UpdatedBy = actor.EffectiveUserId,
        });
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        await InsertOrganizationAuditAsync(
            connection,
            transaction,
            "position",
            positionId,
            "position.created",
            ["name", "sortOrder", "status", "description"],
            actor,
            traceId,
            now,
            cancellationToken).ConfigureAwait(false);
        var created = await LoadPositionAsync(positionId, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException("创建后的职务无法重新读取。");
        await CompleteIdempotencyAsync(
            connection,
            transaction,
            idempotencyId,
            created,
            created.Revision,
            $"/positions/{created.Id:D}",
            now,
            cancellationToken).ConfigureAwait(false);
        await databaseTransaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return Succeeded(created);
    }

    public async Task<OrganizationCommandResult<PositionDto>> UpdatePositionAsync(
        Guid positionId,
        UpdatePositionRequest request,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!request.HasChanges)
        {
            return Failed<PositionDto>(ReferenceDataValidationFailure(
                "职务校验失败",
                [Issue("request", "MIN_PROPERTIES", "至少提供一个需要修改的字段。")]));
        }

        var now = _timeProvider.GetUtcNow();
        await using var databaseTransaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        var (connection, transaction) = GetSqlTransaction(databaseTransaction);
        var position = await _dbContext.Positions
            .SingleOrDefaultAsync(item => item.Id == positionId, cancellationToken)
            .ConfigureAwait(false);
        if (position is null)
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<PositionDto>(PositionNotFoundFailure());
        }

        if (position.Revision != expectedRevision)
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<PositionDto>(RevisionFailure("职务", position.Revision));
        }

        var normalized = NormalizePosition(
            request.Name ?? position.Name,
            request.SortOrder ?? position.SortOrder,
            request.Status ?? ToStatus(position.IsEnabled),
            request.Description ?? position.Description);
        if (normalized.Failure is not null)
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<PositionDto>(normalized.Failure);
        }

        var input = normalized.Value!;
        if (await PositionNameExistsAsync(input.NormalizedName, positionId, cancellationToken)
            .ConfigureAwait(false))
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<PositionDto>(PositionNameConflictFailure());
        }

        position.Name = input.Name;
        position.NormalizedName = input.NormalizedName;
        position.SortOrder = input.SortOrder;
        position.IsEnabled = input.IsEnabled;
        position.Description = input.Description;
        Touch(position, actor.EffectiveUserId, now);
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        await InsertOrganizationAuditAsync(
            connection,
            transaction,
            "position",
            positionId,
            "position.updated",
            GetChangedFields(request),
            actor,
            traceId,
            now,
            cancellationToken).ConfigureAwait(false);
        var updated = await LoadPositionAsync(positionId, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException("更新后的职务无法重新读取。");
        await databaseTransaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return Succeeded(updated);
    }

    public async Task<OrganizationCommandResult<bool>> DeletePositionAsync(
        Guid positionId,
        int expectedRevision,
        WorkflowGroupMutationActor actor,
        string traceId,
        CancellationToken cancellationToken = default)
    {
        var now = _timeProvider.GetUtcNow();
        await using var databaseTransaction = await _dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken)
            .ConfigureAwait(false);
        var (connection, transaction) = GetSqlTransaction(databaseTransaction);
        var position = await _dbContext.Positions
            .SingleOrDefaultAsync(item => item.Id == positionId, cancellationToken)
            .ConfigureAwait(false);
        if (position is null)
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<bool>(PositionNotFoundFailure());
        }

        if (position.Revision != expectedRevision)
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<bool>(RevisionFailure("职务", position.Revision));
        }

        if (await _dbContext.OrganizationUserReferences
            .AnyAsync(user => user.PositionId == positionId, cancellationToken)
            .ConfigureAwait(false))
        {
            await databaseTransaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
            return Failed<bool>(Failure(
                OrganizationCommandError.Conflict,
                "POSITION_IN_USE",
                "职务正在使用",
                "请先调整使用该职务的用户。"));
        }

        await InsertOrganizationAuditAsync(
            connection,
            transaction,
            "position",
            positionId,
            "position.deleted",
            ["position"],
            actor,
            traceId,
            now,
            cancellationToken).ConfigureAwait(false);
        _dbContext.Positions.Remove(position);
        await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await databaseTransaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return Succeeded(true);
    }

    private async Task<DepartmentDto?> LoadDepartmentAsync(
        Guid departmentId,
        CancellationToken cancellationToken)
    {
        var rows = await _dbContext.Departments
            .AsNoTracking()
            .Where(department => department.Id == departmentId || department.ParentId == departmentId)
            .OrderBy(department => department.SortOrder)
            .ThenBy(department => department.Name)
            .ThenBy(department => department.Id)
            .Select(department => new DepartmentRow(
                department.Id,
                department.Revision,
                department.Code,
                department.Name,
                department.ParentId,
                department.Path,
                department.SortOrder,
                department.IsEnabled,
                department.Description ?? string.Empty,
                _dbContext.OrganizationUserReferences.Count(user => user.DepartmentId == department.Id)))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var current = rows.SingleOrDefault(row => row.Id == departmentId);
        return current is null
            ? null
            : ToDepartmentDto(current, rows.Where(row => row.ParentId == departmentId).ToArray());
    }

    private async Task<PositionDto?> LoadPositionAsync(
        Guid positionId,
        CancellationToken cancellationToken) =>
        await _dbContext.Positions
            .AsNoTracking()
            .Where(position => position.Id == positionId)
            .Select(position => new PositionDto(
                position.Id,
                position.Revision,
                position.Name,
                position.SortOrder,
                position.IsEnabled ? "enabled" : "disabled",
                position.Description ?? string.Empty,
                _dbContext.OrganizationUserReferences.Count(user => user.PositionId == position.Id)))
            .SingleOrDefaultAsync(cancellationToken)
            .ConfigureAwait(false);

    private async Task<DepartmentValidationResult> ValidateDepartmentAsync(
        Guid? departmentId,
        Guid? currentParentId,
        NormalizedDepartmentInput input,
        CancellationToken cancellationToken)
    {
        string? parentPath = null;
        if (input.ParentId is { } parentId)
        {
            var parent = await _dbContext.Departments
                .AsNoTracking()
                .SingleOrDefaultAsync(item => item.Id == parentId, cancellationToken)
                .ConfigureAwait(false);
            if (parent is null
                || parent.ParentId is not null
                || (!parent.IsEnabled && parent.Id != currentParentId))
            {
                return new DepartmentValidationResult(null, ReferenceDataValidationFailure(
                    "部门校验失败",
                    [Issue("parentId", "INVALID_REFERENCE", "上级部门必须是存在且可用的一级部门。")]));
            }

            parentPath = parent.Path;
        }

        var duplicateName = await _dbContext.Departments
            .AsNoTracking()
            .AnyAsync(item =>
                item.Id != departmentId
                && item.ParentId == input.ParentId
                && item.Name == input.Name,
                cancellationToken)
            .ConfigureAwait(false);
        if (duplicateName)
        {
            return new DepartmentValidationResult(null, Failure(
                OrganizationCommandError.Conflict,
                "DEPARTMENT_NAME_CONFLICT",
                "同级部门名称已存在",
                "请使用其他部门名称。"));
        }

        return new DepartmentValidationResult(parentPath, null);
    }

    private Task<bool> PositionNameExistsAsync(
        string normalizedName,
        Guid? positionId,
        CancellationToken cancellationToken) =>
        _dbContext.Positions
            .AsNoTracking()
            .AnyAsync(
                position => position.Id != positionId && position.NormalizedName == normalizedName,
                cancellationToken);

    private static NormalizedDepartmentResult NormalizeDepartment(
        string name,
        Guid? parentId,
        int sortOrder,
        string status,
        string? description)
    {
        var issues = new List<OrganizationInputIssueDto>();
        var normalizedName = name.Trim();
        if (normalizedName.Length is < 1 or > 100)
        {
            issues.Add(Issue("name", "INVALID_LENGTH", "部门名称长度必须为 1 到 100 个字符。"));
        }

        var enabled = ParseEnabledStatus(status, issues);
        var normalizedDescription = string.IsNullOrWhiteSpace(description) ? null : description.Trim();
        return issues.Count > 0
            ? new NormalizedDepartmentResult(null, ReferenceDataValidationFailure("部门校验失败", issues))
            : new NormalizedDepartmentResult(
                new NormalizedDepartmentInput(
                    normalizedName,
                    parentId,
                    sortOrder,
                    enabled!.Value,
                    normalizedDescription),
                null);
    }

    private static NormalizedPositionResult NormalizePosition(
        string name,
        int sortOrder,
        string status,
        string? description)
    {
        var issues = new List<OrganizationInputIssueDto>();
        var normalizedName = name.Trim();
        if (normalizedName.Length is < 1 or > 100)
        {
            issues.Add(Issue("name", "INVALID_LENGTH", "职务名称长度必须为 1 到 100 个字符。"));
        }

        var enabled = ParseEnabledStatus(status, issues);
        var normalizedDescription = string.IsNullOrWhiteSpace(description) ? null : description.Trim();
        return issues.Count > 0
            ? new NormalizedPositionResult(null, ReferenceDataValidationFailure("职务校验失败", issues))
            : new NormalizedPositionResult(
                new NormalizedPositionInput(
                    normalizedName,
                    IdentityValueNormalizer.Normalize(normalizedName),
                    sortOrder,
                    enabled!.Value,
                    normalizedDescription),
                null);
    }

    private static bool? ParseEnabledStatus(
        string status,
        List<OrganizationInputIssueDto> issues)
    {
        var enabled = status switch
        {
            "enabled" => true,
            "disabled" => false,
            _ => (bool?)null,
        };
        if (enabled is null)
        {
            issues.Add(Issue("status", "INVALID_VALUE", "状态只能是 enabled 或 disabled。"));
        }

        return enabled;
    }

    private static (SqlConnection Connection, SqlTransaction Transaction) GetSqlTransaction(
        IDbContextTransaction databaseTransaction)
    {
        var transaction = (SqlTransaction)databaseTransaction.GetDbTransaction();
        return ((SqlConnection)transaction.Connection!, transaction);
    }

    private static string CreateCode(string prefix, Guid id, int length) =>
        $"{prefix}-{id:N}"[..length].ToUpperInvariant();

    private static string BuildDepartmentPath(string? parentPath, string name) =>
        string.IsNullOrEmpty(parentPath) ? name : $"{parentPath} / {name}";

    private static string ToStatus(bool isEnabled) => isEnabled ? "enabled" : "disabled";

    private static void Touch(DepartmentEntity department, Guid actorId, DateTimeOffset now)
    {
        department.Revision++;
        department.UpdatedAt = now.UtcDateTime;
        department.UpdatedBy = actorId;
    }

    private static void Touch(PositionEntity position, Guid actorId, DateTimeOffset now)
    {
        position.Revision++;
        position.UpdatedAt = now.UtcDateTime;
        position.UpdatedBy = actorId;
    }

    private static List<string> GetChangedFields(UpdateDepartmentRequest request)
    {
        var fields = new List<string>();
        if (request.Name is not null) fields.Add("name");
        if (request.ParentIdSpecified) fields.Add("parentId");
        if (request.SortOrder is not null) fields.Add("sortOrder");
        if (request.Status is not null) fields.Add("status");
        if (request.Description is not null) fields.Add("description");
        return fields;
    }

    private static List<string> GetChangedFields(UpdatePositionRequest request)
    {
        var fields = new List<string>();
        if (request.Name is not null) fields.Add("name");
        if (request.SortOrder is not null) fields.Add("sortOrder");
        if (request.Status is not null) fields.Add("status");
        if (request.Description is not null) fields.Add("description");
        return fields;
    }

    private static DepartmentDto ToDepartmentDto(
        DepartmentRow row,
        IReadOnlyList<DepartmentRow> childRows) => new(
            row.Id,
            row.Revision,
            row.Code,
            row.Name,
            row.ParentId,
            row.Path,
            row.ParentId is null ? 1 : 2,
            row.SortOrder,
            ToStatus(row.IsEnabled),
            row.Description,
            row.UserCount,
            childRows.Select(child => ToDepartmentDto(child, [])).ToArray());

    private static OrganizationCommandFailure ReferenceDataValidationFailure(
        string title,
        IReadOnlyList<OrganizationInputIssueDto> issues) => Failure(
            OrganizationCommandError.ValidationFailed,
            "VALIDATION_FAILED",
            title,
            "请修正无效字段后重试。",
            issues);

    private static OrganizationCommandFailure DepartmentNotFoundFailure() => Failure(
        OrganizationCommandError.NotFound,
        "DEPARTMENT_NOT_FOUND",
        "部门不存在",
        "未找到指定的部门。");

    private static OrganizationCommandFailure PositionNotFoundFailure() => Failure(
        OrganizationCommandError.NotFound,
        "POSITION_NOT_FOUND",
        "职务不存在",
        "未找到指定的职务。");

    private static OrganizationCommandFailure PositionNameConflictFailure() => Failure(
        OrganizationCommandError.Conflict,
        "POSITION_NAME_CONFLICT",
        "职务名称已存在",
        "请使用其他职务名称。");

    private static OrganizationCommandFailure RevisionFailure(string resourceName, int revision) => Failure(
        OrganizationCommandError.RevisionMismatch,
        "REVISION_MISMATCH",
        $"{resourceName}已被修改",
        "请刷新后基于最新内容重新提交。",
        currentRevision: revision);

    private sealed record NormalizedDepartmentInput(
        string Name,
        Guid? ParentId,
        int SortOrder,
        bool IsEnabled,
        string? Description);

    private sealed record NormalizedDepartmentResult(
        NormalizedDepartmentInput? Value,
        OrganizationCommandFailure? Failure);

    private sealed record DepartmentValidationResult(
        string? ParentPath,
        OrganizationCommandFailure? Failure);

    private sealed record NormalizedPositionInput(
        string Name,
        string NormalizedName,
        int SortOrder,
        bool IsEnabled,
        string? Description);

    private sealed record NormalizedPositionResult(
        NormalizedPositionInput? Value,
        OrganizationCommandFailure? Failure);
}
