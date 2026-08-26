using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FlowPilot.ApiTests.Support;
using FlowPilot.Application.Health;
using FlowPilot.Contracts.Health;

namespace FlowPilot.ApiTests;

public sealed class HealthEndpointsTests
{
    [Fact]
    public async Task LivenessUsesTheContractPathAndDoesNotRunReadinessProbe()
    {
        await using var factory = new FlowPilotApiFactory
        {
            ReadinessResult = DatabaseReadinessResult.NotReady("SHOULD_NOT_BE_OBSERVED"),
        };
        using var client = factory.CreateClient();

        var cancellationToken = TestContext.Current.CancellationToken;
        using var response = await client.GetAsync(
            "/api/flowpilot/v1/health/live",
            cancellationToken);
        var body = await response.Content.ReadFromJsonAsync<LivenessDto>(cancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotNull(body);
        Assert.Equal(HealthStatuses.Ok, body.Status);
        Assert.NotEqual(default, body.CheckedAt);
    }

    [Fact]
    public async Task ReadinessReturnsServiceUnavailableWithStableReasonCode()
    {
        await using var factory = new FlowPilotApiFactory
        {
            ReadinessResult = DatabaseReadinessResult.NotReady(
                DatabaseReadinessCodes.SchemaVersionMismatch),
        };
        using var client = factory.CreateClient();

        var cancellationToken = TestContext.Current.CancellationToken;
        using var response = await client.GetAsync(
            "/api/flowpilot/v1/health/ready",
            cancellationToken);
        var body = await response.Content.ReadFromJsonAsync<ReadinessDto>(cancellationToken);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.NotNull(body);
        Assert.Equal(HealthStatuses.Unavailable, body.Status);
        Assert.Equal(DatabaseReadinessCodes.SchemaVersionMismatch, body.Code);
        Assert.False(string.IsNullOrWhiteSpace(body.Version));
    }

    [Fact]
    public async Task ReadinessOmitsReasonCodeWhenReady()
    {
        await using var factory = new FlowPilotApiFactory();
        using var client = factory.CreateClient();

        var cancellationToken = TestContext.Current.CancellationToken;
        using var response = await client.GetAsync(
            "/api/flowpilot/v1/health/ready",
            cancellationToken);
        var json = await response.Content.ReadAsStringAsync(cancellationToken);
        var body = JsonSerializer.Deserialize<ReadinessDto>(json, JsonSerializerOptions.Web);
        using var document = JsonDocument.Parse(json);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotNull(body);
        Assert.Equal(HealthStatuses.Ok, body.Status);
        Assert.Null(body.Code);
        Assert.False(document.RootElement.TryGetProperty("code", out _));
    }

    [Fact]
    public async Task EndpointIsNotExposedWithoutTheConfiguredApiBasePath()
    {
        await using var factory = new FlowPilotApiFactory();
        using var client = factory.CreateClient();

        var cancellationToken = TestContext.Current.CancellationToken;
        using var response = await client.GetAsync("/health/live", cancellationToken);
        using var body = JsonDocument.Parse(
            await response.Content.ReadAsStringAsync(cancellationToken));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("NOT_FOUND", body.RootElement.GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(
            body.RootElement.GetProperty("traceId").GetString()));
    }

    [Fact]
    public async Task UnknownHostIsRejectedWithContractProblemDetails()
    {
        await using var factory = new FlowPilotApiFactory();
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            "/api/flowpilot/v1/health/live");
        request.Headers.Host = "untrusted.example";

        var cancellationToken = TestContext.Current.CancellationToken;
        using var response = await client.SendAsync(request, cancellationToken);
        using var body = JsonDocument.Parse(
            await response.Content.ReadAsStringAsync(cancellationToken));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("BAD_REQUEST", body.RootElement.GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(
            body.RootElement.GetProperty("traceId").GetString()));
    }

    [Fact]
    public async Task AllowedHostWithoutPortAcceptsTheProxyAuthorityPort()
    {
        await using var factory = new FlowPilotApiFactory();
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            "/api/flowpilot/v1/health/live");
        request.Headers.Host = "localhost:443";

        using var response = await client.SendAsync(
            request,
            TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
