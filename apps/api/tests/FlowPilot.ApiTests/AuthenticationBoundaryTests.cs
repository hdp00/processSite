using System.Net;
using System.Text.Json;
using FlowPilot.ApiTests.Support;

namespace FlowPilot.ApiTests;

public sealed class AuthenticationBoundaryTests(FlowPilotApiFactory factory) : IClassFixture<FlowPilotApiFactory>
{
    [Theory]
    [InlineData("users")]
    [InlineData("roles")]
    [InlineData("permissions")]
    [InlineData("departments")]
    [InlineData("positions")]
    [InlineData("workflow-permission-groups")]
    [InlineData("process-definitions")]
    [InlineData("me/launchable-process-definitions")]
    [InlineData("me/visible-process-definitions")]
    [InlineData("me/workflow-tasks")]
    [InlineData("process-instances")]
    [InlineData("email-outbox")]
    [InlineData("audit-events")]
    public async Task ProtectedCollectionsRejectAnonymousRequestsWithProblemDetails(string route)
    {
        using var client = factory.CreateClient();

        using var response = await client.GetAsync(
            $"/api/flowpilot/v1/{route}",
            TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(
            TestContext.Current.CancellationToken));
        Assert.Equal("AUTHENTICATION_REQUIRED", body.RootElement.GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(body.RootElement.GetProperty("traceId").GetString()));
    }

    [Theory]
    [InlineData("attachments/00000000-0000-0000-0000-000000000001")]
    [InlineData("process-instances/00000000-0000-0000-0000-000000000001")]
    [InlineData("workflow-tasks/00000000-0000-0000-0000-000000000001")]
    [InlineData("email-outbox/00000000-0000-0000-0000-000000000001")]
    [InlineData("audit-events/00000000-0000-0000-0000-000000000001")]
    public async Task ProtectedResourcesDoNotRevealExistenceToAnonymousRequests(string route)
    {
        using var client = factory.CreateClient();

        using var response = await client.GetAsync(
            $"/api/flowpilot/v1/{route}",
            TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }
}
