import { spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const openSpecCli = fileURLToPath(new URL(
  '../.factory/tools/node_modules/@fission-ai/openspec/bin/openspec.js', import.meta.url,
));
const verdictSchema = fileURLToPath(new URL('./verdict.schema.json', import.meta.url));
const planSchema = fileURLToPath(new URL('./plan.schema.json', import.meta.url));
const implementationSchema = fileURLToPath(new URL('./implementation.schema.json', import.meta.url));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const entries = (output) => output.split('\0').filter(Boolean);

function command(cwd, executable, args, { input, log, timeout = 120_000 } = {}) {
  const result = spawnSync(executable, args, {
    cwd, input, timeout, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, OPENSPEC_TELEMETRY: '0', OPENSPEC_NO_UPDATE_CHECK: '1' },
    windowsHide: true,
  });
  if (log) {
    writeFileSync(log, result.stdout ?? '');
    writeFileSync(log + '.stderr', result.stderr ?? '');
  }
  if (result.status !== 0 || result.error) {
    const detail = result.error?.message ?? (result.stderr?.trim() || result.stdout?.trim());
    throw new Error(`${executable} ${args[0]} failed (exit ${result.status ?? 'unknown'}). ${detail ?? ''}${log ? ` See ${log}.` : ''}`);
  }
  return result.stdout;
}

const git = (cwd, ...args) => command(cwd, 'git', args);
const revision = (cwd) => git(cwd, 'rev-parse', 'HEAD').trim();
const dirty = (cwd) => git(cwd, 'status', '--porcelain', '--untracked-files=all').trim();
const openSpec = (cwd, ...args) => command(cwd, process.execPath, [openSpecCli, ...args]);

function worktree(root, path, commit) {
  git(root, 'worktree', 'add', '--detach', path, commit);
}

function saveState(runPath, state) {
  const path = join(runPath, 'run.json');
  writeJson(path + '.tmp', state);
  renameSync(path + '.tmp', path);
}

function invokeCodex({ cwd, prompt, log, output, schema, sandbox = 'workspace-write' }) {
  const args = ['-a', 'never', 'exec', '--disable', 'apps', '--sandbox', sandbox, '--ephemeral', '--json'];
  if (output) args.push('--output-schema', schema, '--output-last-message', output);
  command(cwd, 'codex', [...args, '-'], { input: prompt, log, timeout: 20 * 60_000 });
}

function writeDraft(draft, change, output) {
  const plan = JSON.parse(readFileSync(output, 'utf8'));
  const folder = join(draft, 'openspec', 'changes', change);
  const documents = ['proposal', 'design', 'tasks'];
  const capabilityNames = new Set();
  if (documents.some((name) => typeof plan[name] !== 'string' || !plan[name].trim()) ||
      !Array.isArray(plan.specs) || !plan.specs.length) {
    throw new Error('The planner must return the proposal, design, tasks, and at least one specification.');
  }
  for (const spec of plan.specs) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(spec.capability) || capabilityNames.has(spec.capability) ||
        typeof spec.markdown !== 'string' || !spec.markdown.trim()) {
      throw new Error('Each planned specification needs a unique kebab-case capability and Markdown content.');
    }
    capabilityNames.add(spec.capability);
  }
  for (const name of documents) writeFileSync(join(folder, name + '.md'), plan[name].trim() + '\n');
  for (const spec of plan.specs) {
    const path = join(folder, 'specs', spec.capability);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'spec.md'), spec.markdown.trim() + '\n');
  }
}

function scenarioNames(cwd, changePath) {
  const files = entries(git(cwd, 'ls-files', '-z', '--', `${changePath}/specs/`));
  const names = files.filter((file) => file.endsWith('/spec.md')).flatMap((file) =>
    Array.from(readFileSync(join(cwd, file), 'utf8').matchAll(/^#### Scenario:\s*([^\r\n]+)$/gm),
      (match) => match[1].trim()).filter(Boolean),
  );
  if (!names.length || new Set(names).size !== names.length) {
    throw new Error('The approved change must have at least one scenario and each scenario needs a unique name.');
  }
  return names;
}

function snapshot(draft, state) {
  const changePath = `openspec/changes/${state.change}`;
  const status = JSON.parse(openSpec(draft, 'status', '--change', state.change, '--json'));
  if (!status.isComplete) throw new Error('Complete the OpenSpec proposal, specs, design, and tasks first.');
  openSpec(draft, 'validate', state.change, '--type', 'change', '--strict', '--no-interactive');
  git(draft, 'add', '-A', '--', changePath);
  const changed = entries(git(draft, 'diff', '--cached', '--no-renames', '--name-only', '-z', state.base));
  if (!changed.length || changed.some((file) => !file.startsWith(changePath + '/')) ||
      git(draft, 'diff', '--name-only').trim() || git(draft, 'ls-files', '--others', '--exclude-standard').trim()) {
    throw new Error(`The draft may change only files under ${changePath}.`);
  }
  state.scenarios = scenarioNames(draft, changePath);
  state.approvedRevision = null;
  if (dirty(draft)) git(draft, 'commit', '-m', `Draft OpenSpec change: ${state.change}`);
  state.draftRevision = revision(draft);
  state.status = 'awaiting-approval';
}

function readVerdict(path, expected) {
  const verdict = JSON.parse(readFileSync(path, 'utf8'));
  const { status, summary, scenarios } = verdict;
  if (!['pass', 'defect', 'blocked'].includes(status) || typeof summary !== 'string' || !summary.trim() ||
      !Array.isArray(scenarios) || scenarios.some((scenario) =>
        !expected.includes(scenario?.name) || !['pass', 'fail'].includes(scenario.outcome) ||
        !Number.isInteger(scenario.exitCode) ||
        ![scenario.command, scenario.observed].every((value) => typeof value === 'string' && value.trim())) ||
      new Set(scenarios.map((scenario) => scenario.name)).size !== scenarios.length ||
      (status !== 'blocked' && scenarios.length !== expected.length) ||
      (status === 'pass' && scenarios.some((item) => item.outcome !== 'pass')) ||
      (status === 'defect' && !scenarios.some((item) => item.outcome === 'fail'))) {
    throw new Error('Verifier response does not contain consistent evidence for the approved scenarios.');
  }
  return verdict;
}

function implementAndVerify(root, runPath, state, codex) {
  const changePath = `openspec/changes/${state.change}`;
  const implementation = join(runPath, 'implementation');
  worktree(root, implementation, state.approvedRevision);
  let feedback = '';
  for (const attempt of [1, 2]) {
    const previous = revision(implementation);
    const implementationLog = join(runPath, `implementation-${attempt}.jsonl`);
    const implementationOutput = join(runPath, `implementation-${attempt}.json`);
    const result = { attempt, implementationLog, implementationOutput };
    state.attempts.push(result);
    saveState(runPath, state);
    console.log(`Implementing attempt ${attempt} in ${implementation}`);
    codex({
      cwd: implementation,
      log: implementationLog, output: implementationOutput, schema: implementationSchema,
      prompt: `Implement the approved OpenSpec change at ${changePath} in this checkout.
Read its proposal, specs, design, and tasks. Keep the change focused and run relevant checks.
Leave all OpenSpec files as approved. Leave the changes in the worktree for the factory to commit.
Report "ready" when the checkout is ready to verify. If a tool or environment failure prevents
implementation, report "blocked" and describe the failure in the summary.
Never push, merge, deploy, or run offensive security tasks.
${feedback}`,
    });
    const report = JSON.parse(readFileSync(implementationOutput, 'utf8'));
    if (!['ready', 'blocked'].includes(report.status) || typeof report.summary !== 'string' || !report.summary.trim()) {
      throw new Error('Implementer response does not contain a valid status and summary.');
    }
    result.implementationStatus = report.status;
    if (report.status === 'blocked') {
      result.status = 'blocked';
      throw new Error(report.summary);
    }
    if (revision(implementation) !== previous ||
        git(implementation, 'status', '--porcelain', '--untracked-files=all', '--', 'openspec').trim()) {
      throw new Error('The implementer changed the Git revision or the approved OpenSpec files.');
    }
    if (dirty(implementation)) {
      git(implementation, 'add', '-A');
      git(implementation, 'commit', '-m', `Implement ${state.change} (attempt ${attempt})`);
    }
    const candidate = revision(implementation);
    const verification = join(runPath, `verification-${attempt}`);
    const log = join(runPath, `verification-${attempt}.jsonl`);
    const output = join(runPath, `verdict-${attempt}.json`);
    Object.assign(result, { candidate, log, output });
    saveState(runPath, state);
    worktree(root, verification, candidate);
    console.log(`Verifying ${candidate} in ${verification}`);
    codex({
      cwd: verification, log, output, schema: verdictSchema,
      prompt: `Independently verify candidate ${candidate} against the approved OpenSpec change at ${changePath}.
Exercise each approved scenario and give its exact heading as the name. Record actual commands,
exit codes, and observations. A scenario that expects a command to fail can pass.
Use status "defect" for an observed requirement failure, "blocked" for missing prerequisites
or inability to run checks, and "pass" only with passing evidence for every scenario.
For "defect", include results for all scenarios. For "blocked", explain what you could not run.
Keep the checkout's versioned files unchanged. Use temporary fixtures outside versioned paths.
Stop any local test servers you start. Never push, deploy, or run offensive security tasks.`,
    });
    if (revision(verification) !== candidate || dirty(verification)) {
      throw new Error('The verifier modified its checkout. Its verdict cannot be used.');
    }
    const verdict = readVerdict(output, state.scenarios);
    result.status = verdict.status;
    saveState(runPath, state);
    if (verdict.status === 'blocked') throw new Error(verdict.summary);
    if (verdict.status === 'pass') return 'passed';
    feedback = `Repair the verified defects below without changing the approved requirements.\n${JSON.stringify(verdict)}`;
  }
  return 'rejected';
}

const usage = `Usage:
  factory.ps1 plan --change <kebab-case-id> --request <text>
  factory.ps1 snapshot --run <id>
  factory.ps1 approve --run <id> --revision <reviewed-commit>
  factory.ps1 status --run <id>`;

export function main(argv, { cwd = process.cwd(), codex = invokeCodex } = {}) {
  const [action, ...args] = argv;
  if (!action || action === '--help') {
    console.log(usage);
    return 0;
  }
  const options = {
    plan: ['change', 'request'], snapshot: ['run'], approve: ['run', 'revision'], status: ['run'],
  };
  if (!Object.hasOwn(options, action)) throw new Error(usage);
  const { values } = parseArgs({
    args,
    options: Object.fromEntries(options[action].map((name) => [name, { type: 'string' }])),
  });
  for (const name of options[action]) {
    if (!values[name]?.trim()) throw new Error(`Provide --${name}.\n${usage}`);
  }
  if ((values.change && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.change)) ||
      (values.run && !/^[a-f0-9-]{36}$/.test(values.run))) {
    throw new Error('Use a kebab-case change ID and a run ID printed by the factory.');
  }
  const root = git(cwd, 'rev-parse', '--show-toplevel').trim();
  const runId = values.run ?? randomUUID();
  const runs = join(root, '.factory', 'runs');
  const runPath = join(runs, runId);
  const draft = join(runPath, 'draft');
  const stateFile = join(runPath, 'run.json');
  if (action === 'status') {
    console.log(readFileSync(stateFile, 'utf8').trim());
    return 0;
  }
  if (action === 'plan' || action === 'snapshot') {
    if (!existsSync(openSpecCli)) throw new Error('Install the repository-local OpenSpec CLI as shown in README.md.');
  }
  if (action === 'plan') {
    mkdirSync(runs, { recursive: true });
    mkdirSync(runPath);
  }
  const lockPath = join(runPath, 'run.lock');
  const lock = openSync(lockPath, 'wx');
  try {
    const state = action === 'plan'
      ? { runId, change: values.change, base: revision(root), status: 'draft', attempts: [] }
      : JSON.parse(readFileSync(stateFile, 'utf8'));
    if (action === 'plan') {
      saveState(runPath, state);
      console.log(`Run ${runId}. Draft checkout: ${draft}`);
      worktree(root, draft, state.base);
      mkdirSync(join(draft, 'openspec', 'changes'), { recursive: true });
      const config = join(draft, 'openspec', 'config.yaml');
      const hadConfig = existsSync(config);
      openSpec(draft, 'new', 'change', state.change, '--schema', 'spec-driven');
      // OpenSpec may create a default config when starting from a pre-OpenSpec commit.
      if (!hadConfig && existsSync(config)) unlinkSync(config);
      const templates = JSON.parse(openSpec(draft, 'templates', '--schema', 'spec-driven', '--json'));
      const artifactGuidance = ['proposal', 'specs', 'design', 'tasks'].map((artifact) =>
        `${artifact}:\n${readFileSync(templates[artifact].path, 'utf8')}`,
      ).join('\n\n');
      const readme = join(draft, 'README.md');
      const output = join(runPath, 'plan.json');
      codex({
        cwd: draft,
        log: join(runPath, 'planning.jsonl'),
        output, schema: planSchema, sandbox: 'read-only',
        prompt: `Draft OpenSpec change ${state.change} for the developer request below.
Return the proposal, design, tasks, and capability specifications as Markdown strings in the JSON schema.
Use the local repository context and OpenSpec's spec-driven conventions. Use distinct scenario headings
and observable acceptance criteria. Keep this phase read-only. Never push, deploy, or plan offensive security tasks.

Tracked paths:
${git(draft, 'ls-files').slice(0, 10_000)}

Repository README:
${existsSync(readme) ? readFileSync(readme, 'utf8').slice(0, 12_000) : '(none)'}

OpenSpec artifact templates:
${artifactGuidance}

Developer request:
${values.request}`,
      });
      writeDraft(draft, state.change, output);
      snapshot(draft, state);
    } else if (action === 'snapshot') {
      if (!['draft', 'awaiting-approval'].includes(state.status)) {
        throw new Error(`Run ${runId} cannot be revised in state ${state.status}.`);
      }
      snapshot(draft, state);
    } else {
      if (state.status !== 'awaiting-approval' || values.revision !== state.draftRevision ||
          revision(draft) !== state.draftRevision || dirty(draft)) {
        throw new Error('Approval requires the latest clean draft revision. Review and snapshot any edits first.');
      }
      state.approvedRevision = state.draftRevision;
      state.status = 'running';
      saveState(runPath, state);
      try {
        state.status = implementAndVerify(root, runPath, state, codex);
      } catch (error) {
        state.status = 'blocked';
        state.error = error.message;
      }
    }
    saveState(runPath, state);
    console.log(`Run ${runId}: ${state.status}. Evidence: ${stateFile}`);
    if (state.status === 'awaiting-approval') console.log(`Draft revision: ${state.draftRevision}`);
    if (state.error) console.error(state.error);
    return state.status === 'blocked' ? 1 : state.status === 'rejected' ? 2 : 0;
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
