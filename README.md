# ABP AG-UI Lab

A compact, local-only integration sample, not a production ABP template. No database, auth server, or Node runtime service required. Angular is standalone, not the ABP Angular shell.

## Requirements
.NET 10 SDK, Node 22.12+ (22 LTS recommended), npm, network access to NuGet/npm. Ports 5080 and 4200. The MAF hosting package is a preview. Angular 20 and ABP 10.0 are used. The JS AG-UI package uses the npm latest tag; the committed lockfile records the installed versions.

## Run without an API key
Terminal 1:
```sh
cd server
dotnet restore
dotnet run --urls http://localhost:5080
```
Terminal 2:
```sh
cd angular
npm install
npm start
```
Open http://localhost:4200, click Send. Expect a streamed text response, catalog table and event inspector. The mock endpoint emits a fixed protocol sequence and calls the in-memory ABP service; it does not run MAF or AGUI.Server. It ignores the prompt intentionally. Stop cancels the browser request; New conversation replaces the client state. Refresh discards history.

## Enable actual MAF hosting
Stop the server, then from server/:
```sh
dotnet user-secrets set 'OpenAI:ApiKey' 'YOUR_KEY'
dotnet user-secrets set 'OpenAI:Model' 'gpt-4o-mini'
```
Set `ASPNETCORE_ENVIRONMENT=Development` in your shell to load user secrets, or use `OPENAI_API_KEY` and optional `OpenAI__Model` environment variables. Restart the server. GET http://localhost:5080/api/status reports `maf`. Try “Find keyboards and tell me the price and stock.” This uses MapAGUIServer and the real agent tool. The model may choose not to call a tool; tool results are rendered as a table only if they match the expected array schema (otherwise inspect the raw event). No API key goes to the browser. OpenAI usage may incur charges.

## Troubleshooting streaming errors
`RUN_ERROR` with code `StreamingError` is AGUI.Server's generic response when the agent stream throws. Check the server terminal: model failures are logged by `LoggingChatClient`, and AG-UI run failures include the run ID, original error type and message. The UI displays the run ID for correlation; exception details stay on the server.

For `HTTP 429 (insufficient_quota: credit_balance_exhausted)`, the configured OpenAI API account has exhausted its credits. Add API credits at https://platform.openai.com/settings/organization/billing/ or configure a key for an API project with available quota, then retry. Retrying with the same exhausted quota will keep failing. To use the local fixture while resolving billing, clear `OpenAI:ApiKey` from all active configuration sources (including `appsettings.Development.json` and user secrets) and unset `OPENAI_API_KEY`, then restart; `/api/status` should report `mock`.

## Optional .NET consumer
With the server running, in a third terminal:
```sh
cd client
dotnet run -- "Show all products"
```
This separate console project directly references AGUI.Client and consumes the same HTTP endpoint via IChatClient. The Angular application instead uses @ag-ui/client. The server hosting package brings AGUI.Server transitively. Inspect with `dotnet list server/Demo.csproj package --include-transitive` from the repository root.

## Architecture
Angular HttpAgent -> POST /api/agent -> MAF MapAGUIServer -> AGUI.Server -> AIAgent -> ABP CatalogAppService. In mock mode the endpoint is a hand-written SSE fixture instead. The console client is an alternative consumer, not a dependency of the server.

## Smoke checks
- `dotnet build server/Demo.csproj` and `dotnet build client/Client.csproj` from root.
- `cd angular && npm install && npm run build`.
- In mock mode send a message and inspect RUN_STARTED, TOOL_CALL_*, TEXT_MESSAGE_* and RUN_FINISHED.
- Send twice, reset, and cancel during a stream. In real mode check that the tool is invoked and no prices are invented.

With the server running in mock mode, run `node scripts/check-mock-stream.mjs`
to verify that the requested run starts and finishes. Use `--url` for a server
on a different local port.

## Multi-agent Software Factory

Install PowerShell 7, Git (with a commit identity), Node.js 22 or newer, and
the Codex CLI. Sign in with `codex login`.

The factory starts from the current Git commit and keeps its worktrees under the
ignored `.factory/runs` directory. Give it a request for the behavior you want.

```powershell
.\factory.ps1 plan --change improve-mock-stream-diagnostics --request "When the mock stream check reports a missing RUN_FINISHED event, include the endpoint and requested run ID."
```

Review the printed `specs/<change-id>.md` file in the draft worktree. It contains the goal,
planned work, and named acceptance scenarios. Each scenario has a `When`
condition and a `Then` result. Edit it if needed, then approve the current
contents using the run ID from `plan`.

```powershell
.\factory.ps1 approve --run <run-id>
.\factory.ps1 status --run <run-id>
```

Approval validates the draft, records its Git revision, and starts the
implementer. For an unchanged draft, you can pass `--revision <draft-commit>`
to approve that exact revision. The factory commits the candidate in its
worktree and launches a fresh verifier in a separate checkout. The verifier
records the command, exit code, and observed evidence for each acceptance
scenario. A defect gives the implementer one repair attempt and starts a fresh
verifier. To change the approved behavior, start a new run for the revised request.

The approval command exits with `0` for a pass, `1` if the factory cannot
complete verification, or `2` if the repaired candidate still has a defect.
Inspect the run's `run.json`, Codex logs, verdicts, and commits before using the
candidate. The factory leaves the worktrees available for inspection. When
finished, remove them with `git worktree remove <checkout-path>`.

On compatible Windows hosts, pass `--windows-sandbox mxc` to select Codex's
MXC sandbox for the factory's agents. If an approved run was blocked before
any verified defect, retry it with its original approval. The factory keeps
earlier logs and worktrees and uses an existing candidate commit if the
implementer had already submitted one.

```powershell
.\factory.ps1 retry --run <run-id> --windows-sandbox mxc
```

Run `node --test factory/*.test.mjs` to exercise the workflow with controlled
agent responses. To replay the stream cases against a
running mock server, use `node factory/mock-stream.test.mjs --url http://localhost:5080`.

## Limits / production migration
Server, console client and Angular builds have passed. A direct HTTP smoke check verified that mock mode streams through RUN_FINISHED. The real OpenAI path was exercised and returned a provider quota error; a successful real-agent response remains unverified. Browser interaction checks remain manual. Do not expose either endpoint publicly: no authentication, permissions, tenant isolation, rate limiting, persistent state or production auditing. In an existing ABP app, use the authenticated request scope for tools rather than the demo's independent DI scope, enforce authorization for every tool, validate thread ownership and use appropriate UoW boundaries. Configure safe session persistence and secure logs. The inspector handles selected events, not every AG-UI event. The table is a fixed typed renderer, not an arbitrary generative UI engine. The OpenAI path is not exercised by mock mode.

## References
- https://learn.microsoft.com/en-us/agent-framework/integrations/by-component/ui/ag-ui/getting-started
- https://github.com/microsoft/agent-framework/blob/main/dotnet/src/Microsoft.Agents.AI.AGUI/README.md
- https://github.com/ag-ui-protocol/ag-ui/tree/main/docs/sdk/js/client
- https://abp.io/docs/10.0/get-started/empty-aspnet-core-application
- https://www.nuget.org/packages/Microsoft.Agents.AI.Hosting.AGUI.AspNetCore/1.28.0-preview.261106.1
