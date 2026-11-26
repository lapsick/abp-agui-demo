using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Hosting.AGUI.AspNetCore;
using Microsoft.Extensions.AI;
using Volo.Abp;
using Volo.Abp.AspNetCore.Mvc;
using Volo.Abp.Application.Services;
using Volo.Abp.Modularity;
using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;
using AGUI.Server;

var builder = WebApplication.CreateBuilder(args);
await builder.AddApplicationAsync<DemoModule>();
builder.Services.AddAGUIServer();
var app = builder.Build();
await app.InitializeApplicationAsync();
// AGUI.Server 1.0 converts stream exceptions into a sanitized RUN_ERROR.
// Its run activity retains the original error type and message for server diagnostics.
using var runDiagnostics = new ActivityListener
{
    ShouldListenTo = source => source.Name == AGUIServerInstrumentation.ActivitySourceName,
    Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllData,
    SampleUsingParentId = (ref ActivityCreationOptions<string> _) => ActivitySamplingResult.AllData,
    ActivityStopped = activity =>
    {
        if (activity.Status == ActivityStatusCode.Error)
        {
            app.Logger.LogError("AG-UI run {RunId} failed ({ErrorType}): {ErrorMessage}",
                activity.GetTagItem("agui.run_id"), activity.GetTagItem("error.type"), activity.StatusDescription);
        }
    }
};
ActivitySource.AddActivityListener(runDiagnostics);

var key = app.Configuration["OpenAI:ApiKey"];
if (string.IsNullOrWhiteSpace(key))
{
    key = Environment.GetEnvironmentVariable("OPENAI_API_KEY");
}
if (!string.IsNullOrWhiteSpace(key))
{
    IChatClient chat = new OpenAI.Chat.ChatClient(app.Configuration["OpenAI:Model"] ?? "gpt-4o-mini", key)
        .AsIChatClient().AsBuilder().UseLogging(app.Services.GetRequiredService<ILoggerFactory>()).Build();
    // Resolve the ABP service inside a fresh scope for each invocation.
    var scopes = app.Services.GetRequiredService<IServiceScopeFactory>();
    async Task<Product[]> FindProducts(string query)
    {
        await using var scope = scopes.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<CatalogAppService>().SearchAsync(query);
    }
    AIAgent agent = chat.AsAIAgent(name: "CatalogAssistant", instructions: "You are a catalog assistant. Use find_products to look up products. Never invent prices.", tools: [AIFunctionFactory.Create(FindProducts, "find_products", "Search the demo product catalog by name. Use an empty query for all products.")]);
    app.MapAGUIServer("/api/agent", agent);
}
else
{
    // Deterministic local transport fixture, deliberately not a MAF agent.
    app.MapPost("/api/agent", async (HttpContext ctx, CatalogAppService catalog) =>
    {
        var ct = ctx.RequestAborted;
        using var doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ct);
        var root = doc.RootElement;
        var threadId = root.GetProperty("threadId").GetString();
        var runId = root.GetProperty("runId").GetString();
        var messageId = Guid.NewGuid().ToString();
        var toolCallId = Guid.NewGuid().ToString();
        ctx.Response.ContentType = "text/event-stream";
        ctx.Response.Headers.CacheControl = "no-cache";
        async Task Emit(object data) { await ctx.Response.WriteAsync($"data: {JsonSerializer.Serialize(data)}\n\n", ct); await ctx.Response.Body.FlushAsync(ct); }
        await Emit(new { type = "RUN_STARTED", threadId, runId });
        await Emit(new { type = "TOOL_CALL_START", toolCallId, toolCallName = "find_products" });
        await Emit(new { type = "TOOL_CALL_ARGS", toolCallId, delta = "{\"query\":\"\"}" });
        await Emit(new { type = "TOOL_CALL_END", toolCallId });
        var products = await catalog.SearchAsync("");
        await Emit(new { type = "TOOL_CALL_RESULT", messageId = Guid.NewGuid().ToString(), toolCallId, content = JsonSerializer.Serialize(products, new JsonSerializerOptions(JsonSerializerDefaults.Web)), role = "tool" });
        await Emit(new { type = "TEXT_MESSAGE_START", messageId, role = "assistant" });
        foreach (var chunk in new[] { "**Demo mode:** ", "I found ", $"{products.Length} products in the catalog. ", "Configure an OpenAI key to enable real agent reasoning." })
        { await Emit(new { type = "TEXT_MESSAGE_CONTENT", messageId, delta = chunk }); await Task.Delay(180, ct); }
        await Emit(new { type = "TEXT_MESSAGE_END", messageId });
        await Emit(new { type = "RUN_FINISHED", threadId, runId });
    });
}
app.MapGet("/api/status", () => new { mode = string.IsNullOrWhiteSpace(key) ? "mock" : "maf" });
await app.RunAsync();

[DependsOn(typeof(AbpAspNetCoreMvcModule))]
public class DemoModule : AbpModule { }
public record Product(string Name, decimal Price, int Stock);
public class CatalogAppService : ApplicationService
{
    public Task<Product[]> SearchAsync(string query) => Task.FromResult(new Product[] {
        new("Mechanical keyboard", 89m, 12), new("USB-C hub", 49m, 8), new("Monitor", 249m, 4)
    }.Where(p => p.Name.Contains(query ?? "", StringComparison.OrdinalIgnoreCase)).ToArray());
}
