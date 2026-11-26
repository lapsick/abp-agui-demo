using AGUI.Client;
using Microsoft.Extensions.AI;
using var http = new HttpClient { BaseAddress = new Uri("http://localhost:5080") };
IChatClient client = new AGUIChatClient(new AGUIChatClientOptions(http, "/api/agent"));
await foreach (var update in client.GetStreamingResponseAsync(args.Length == 0 ? "List products" : string.Join(' ', args)))
    Console.Write(update.Text);
Console.WriteLine();
