using Microsoft.Extensions.Configuration;
using MimeKit;

namespace FlowPilot.Infrastructure.BackgroundJobs;

internal readonly record struct TestEmailOverride(bool Configured, string? Address)
{
    public const string ConfigurationKey = "FlowPilot:Smtp:TestEMail";

    public static TestEmailOverride Read(IConfiguration? configuration)
    {
        var configuredValue = configuration?[ConfigurationKey];
        if (string.IsNullOrWhiteSpace(configuredValue))
        {
            return new TestEmailOverride(false, null);
        }

        return MailboxAddress.TryParse(configuredValue.Trim(), out var mailbox)
            ? new TestEmailOverride(true, mailbox.Address)
            : new TestEmailOverride(true, null);
    }
}
