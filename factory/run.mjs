import { spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const verdictSchema = fileURLToPath(new URL('./verdict.schema.json', import.meta.url));
const planSchema = fileURLToPath(new URL('./plan.schema.json', import.meta.url));
const implementationSchema = fileURLToPath(new URL('./implementation.schema.json', import.meta.url));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const entries = (output) => output.split('\0').filter(Boolean);

function command(cwd, executable, args, { input, log, timeout = 120_000 } = {}) {
  const result = spawnSync(executable, args, {
    cwd, input, timeout, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
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
const specification = (state) => state.specPath ?? `openspec/changes/${state.change}`;

function worktree(root, path, commit) {
  git(root, 'worktree', 'add', '--detach', path, commit);
}

function saveState(runPath, state) {
  const path = join(runPath, 'run.json');
  writeJson(path + '.tmp', state);
  renameSync(path + '.tmp', path);
}

function invokeCodex({ cwd, prompt, log, output, schema, windowsSandbox, sandbox = 'workspace-write' }) {
  const config = windowsSandbox ? ['-c', `windows.sandbox=${windowsSandbox}`] : [];
  const args = [...config, '-a', 'never', 'exec', '--disable', 'apps', '--sandbox', sandbox, '--ephemeral', '--json'];
  if (output) args.push('--output-schema', schema, '--output-last-message', output);
  command(cwd, 'codex', [...args, '-'], { input: prompt, log, timeout: 20 * 60_000 });
}

function writeDraft(draft, state, output) {
  const { goal, work, scenarios } = JSON.parse(readFileSync(output, 'utf8'));
  if (![goal, work].every((value) => typeof value === 'string' && value.trim()) ||
      !Array.isArray(scenarios) || !scenarios.length || scenarios.some((scenario) =>
        ![scenario?.name, scenario?.when, scenario?.then].every((value) =>
          typeof value === 'string' && value.trim() && !/[\r\n]/.test(value),
        ),
      )) {
    throw new Error('The planner must provide a goal, planned work, and named scenarios with conditions and expected results.');
  }
  const acceptance = scenarios.map(({ name, when, then }) =>
    `### Scenario: ${name.trim()}\n\n- When: ${when.trim()}\n- Then: ${then.trim()}`,
  ).join('\n\n');
  mkdirSync(join(draft, 'specs'), { recursive: true });
  writeFileSync(join(draft, state.specPath),
    `# ${state.change}\n\n## Goal\n\n${goal.trim()}\n\n## Planned work\n\n${work.trim()}\n\n## Acceptance scenarios\n\n${acceptance}\n`);
}

function scenarioNames(draft, state) {
  let names;
  if (state.specPath) {
    const markdown = git(draft, 'show', `:${state.specPath}`).replace(/\r\n/g, '\n');
    const sections = markdown.split(/^## (Goal|Planned work|Acceptance scenarios)[ \t]*$/m);
    const [, goalHeading, goal, workHeading, work, acceptanceHeading, acceptance] = sections;
    if (sections.length !== 7 || goalHeading !== 'Goal' || workHeading !== 'Planned work' ||
        acceptanceHeading !== 'Acceptance scenarios' || !goal.trim() || !work.trim()) {
      throw new Error('The spec needs nonempty Goal and Planned work sections followed by Acceptance scenarios.');
    }
    const [intro, ...scenarios] = acceptance.split(/^### Scenario:[ \t]*/m);
    if (intro.trim()) throw new Error('Start each acceptance scenario with a `### Scenario: <name>` heading.');
    names = scenarios.map((scenario) => {
      const [name, ...body] = scenario.split('\n');
      if (!body.some((line) => /^- When:[ \t]*\S/.test(line)) ||
          !body.some((line) => /^- Then:[ \t]*\S/.test(line))) {
        throw new Error(`Scenario "${name.trim()}" needs nonempty When and Then entries.`);
      }
      return name.trim();
    });
  } else {
    // Drafts created by earlier factory versions keep their original specification layout.
    const path = specification(state);
    if (!['proposal.md', 'design.md', 'tasks.md'].every((file) => existsSync(join(draft, path, file)))) {
      throw new Error('The existing draft is missing its proposal, design, or tasks.');
    }
    const files = entries(git(draft, 'ls-files', '-z', '--', `${path}/specs/`));
    names = files.filter((file) => file.endsWith('/spec.md')).flatMap((file) =>
      Array.from(git(draft, 'show', `:${file}`).matchAll(/^#### Scenario:[ \t]*([^\r\n]+)$/gm),
        (match) => match[1].trim()),
    );
  }
  if (!names.length || names.some((name) => !name) || new Set(names).size !== names.length) {
    throw new Error('The spec must have at least one scenario and each scenario needs a unique name.');
  }
  return names;
}

function recordDraft(draft, state) {
  const changePath = specification(state);
  if (state.specPath && !existsSync(join(draft, changePath))) {
    throw new Error(`The draft specification is missing from ${changePath}.`);
  }
  git(draft, 'add', '-A', '--', changePath);
  const changed = entries(git(draft, 'diff', '--cached', '--no-renames', '--name-only', '-z', state.base));
  const inSpec = (file) => state.specPath ? file === changePath : file.startsWith(changePath + '/');
  const outsideSpec = git(draft, 'status', '--porcelain', '--untracked-files=all', '--', '.', `:(exclude)${changePath}`);
  if (!changed.length || changed.some((file) => !inSpec(file)) || outsideSpec.trim()) {
    throw new Error(`The draft may change only its specification at ${changePath}.`);
  }
  state.scenarios = scenarioNames(draft, state);
  state.approvedRevision = null;
  if (dirty(draft)) git(draft, 'commit', '-m', `Draft specification: ${state.change}`);
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

function implementCandidate(implementation, executionPath, runPath, state, result, codex, feedback) {
  const spec = specification(state);
  const { attempt } = result;
  const previous = revision(implementation);
  const implementationLog = join(executionPath, `implementation-${attempt}.jsonl`);
  const implementationOutput = join(executionPath, `implementation-${attempt}.json`);
  Object.assign(result, { implementationLog, implementationOutput });
  saveState(runPath, state);
  console.log(`Implementing attempt ${attempt} in ${implementation}`);
  codex({
    cwd: implementation,
    log: implementationLog, output: implementationOutput, schema: implementationSchema,
    prompt: `Implement the approved specification at ${spec} in this checkout.
Read the requirements and acceptance scenarios. Keep the change focused and run relevant checks.
Leave the approved specification untouched and leave the implementation in the worktree for the factory to commit.
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
      git(implementation, 'status', '--porcelain', '--untracked-files=all', '--', spec).trim()) {
    throw new Error('The implementer changed the Git revision or the approved specification.');
  }
  if (dirty(implementation)) {
    git(implementation, 'add', '-A');
    git(implementation, 'commit', '-m', `Implement ${state.change} (attempt ${attempt})`);
  }
  return revision(implementation);
}

function implementAndVerify(root, runPath, executionPath, state, codex, priorCandidate) {
  const spec = specification(state);
  const implementation = join(executionPath, 'implementation');
  worktree(root, implementation, priorCandidate ?? state.approvedRevision);
  let feedback = '';
  for (const attempt of [1, 2]) {
    const result = { attempt };
    state.attempts.push(result);
    const candidate = attempt === 1 && priorCandidate
      ? priorCandidate
      : implementCandidate(implementation, executionPath, runPath, state, result, codex, feedback);
    const verification = join(executionPath, `verification-${attempt}`);
    const log = join(executionPath, `verification-${attempt}.jsonl`);
    const output = join(executionPath, `verdict-${attempt}.json`);
    Object.assign(result, { candidate, log, output });
    saveState(runPath, state);
    worktree(root, verification, candidate);
    console.log(`Verifying ${candidate} in ${verification}`);
    codex({
      cwd: verification, log, output, schema: verdictSchema,
      prompt: `Independently verify candidate ${candidate} against the approved specification at ${spec}.
Exercise each approved scenario and give its exact heading as the name. Record actual commands,
exit codes, and observations. A scenario that expects a command to fail can pass.
Use status "defect" for an observed requirement failure, "blocked" for missing prerequisites
or inability to run checks, and "pass" only with passing evidence for every scenario.
For "defect", include results for all scenarios. For "blocked", explain what you could not run.
Keep the checkout's versioned files unchanged. Use temporary fixtures outside versioned paths.
Stop any local test servers you start. Never push, deploy, or run offensive security tasks.`,
    });
    if (revision(verification) !== candidate || git(verification, 'status', '--porcelain', '--untracked-files=no').trim()) {
      throw new Error('The verifier changed its revision or tracked files. Its verdict cannot be used.');
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
  factory.ps1 plan --change <kebab-case-id> --request <text> [--windows-sandbox mxc]
  factory.ps1 approve --run <id> [--revision <reviewed-commit>] [--windows-sandbox mxc]
  factory.ps1 retry --run <id> [--windows-sandbox mxc]
  factory.ps1 status --run <id>`;

export function main(argv, { cwd = process.cwd(), codex = invokeCodex } = {}) {
  const [action, ...args] = argv;
  if (!action || action === '--help') {
    console.log(usage);
    return 0;
  }
  const options = {
    plan: ['change', 'request'], approve: ['run'], retry: ['run'], status: ['run'],
  };
  if (!Object.hasOwn(options, action)) throw new Error(usage);
  const optionNames = [...options[action]];
  if (['plan', 'approve', 'retry'].includes(action)) optionNames.push('windows-sandbox');
  if (action === 'approve') optionNames.push('revision');
  const { values } = parseArgs({
    args,
    options: Object.fromEntries(optionNames.map((name) => [name, { type: 'string' }])),
  });
  for (const name of options[action]) {
    if (!values[name]?.trim()) throw new Error(`Provide --${name}.\n${usage}`);
  }
  if (values.change && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.change)) {
    throw new Error('Use a kebab-case change ID.');
  }
  if (values.run && !/^[a-f0-9-]{36}$/.test(values.run)) {
    throw new Error('Use a run ID printed by the factory.');
  }
  const windowsSandbox = values['windows-sandbox'];
  if (windowsSandbox !== undefined && windowsSandbox !== 'mxc') {
    throw new Error('Use --windows-sandbox mxc to select MXC.');
  }
  const launch = (request) => codex({ ...request, windowsSandbox });
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
  if (action === 'plan') {
    mkdirSync(runs, { recursive: true });
    mkdirSync(runPath);
  }
  const lockPath = join(runPath, 'run.lock');
  const lock = openSync(lockPath, 'wx');
  try {
    const state = action === 'plan'
      ? { runId, change: values.change, specPath: `specs/${values.change}.md`,
          base: revision(root), status: 'draft', attempts: [] }
      : JSON.parse(readFileSync(stateFile, 'utf8'));
    if (action === 'plan') {
      saveState(runPath, state);
      console.log(`Run ${runId}. Draft specification: ${join(draft, state.specPath)}`);
      worktree(root, draft, state.base);
      if (existsSync(join(draft, state.specPath))) throw new Error('The spec already exists. Choose a new change ID.');
      const readme = join(draft, 'README.md');
      const output = join(runPath, 'plan.json');
      launch({
        cwd: draft,
        log: join(runPath, 'planning.jsonl'),
        output, schema: planSchema, sandbox: 'read-only',
        prompt: `Draft a specification for ${state.change} based on the developer request below.
Describe the goal and planned work, including design decisions and any prerequisites needed to verify the change.
Return named acceptance scenarios with a single-line condition and a single-line observable expected result for each.
Use distinct scenario names. Keep this phase read-only. Never push, deploy, or plan offensive security tasks.

Tracked paths:
${git(draft, 'ls-files').slice(0, 10_000)}

Repository README:
${existsSync(readme) ? readFileSync(readme, 'utf8').slice(0, 12_000) : '(none)'}

Developer request:
${values.request}`,
      });
      writeDraft(draft, state, output);
      recordDraft(draft, state);
    } else {
      let executionPath = runPath;
      let priorCandidate;
      if (action === 'approve') {
        if (!['draft', 'awaiting-approval'].includes(state.status)) {
          throw new Error(`Run ${runId} cannot be approved in state ${state.status}.`);
        }
        if (revision(draft) !== (state.draftRevision ?? state.base)) {
          throw new Error('The draft checkout moved to a different Git revision.');
        }
        if (values.revision === undefined) {
          recordDraft(draft, state);
        } else if (values.revision !== state.draftRevision || dirty(draft)) {
          throw new Error('The draft does not match the specified revision. Review the draft before approving its current contents.');
        }
        state.approvedRevision = state.draftRevision;
        console.log(`Approved specification revision: ${state.approvedRevision}`);
      } else {
        if (state.status !== 'blocked' || !state.approvedRevision ||
            state.attempts.some((attempt) => attempt.status === 'defect')) {
          throw new Error('Retry requires an approved run that was blocked before any verified defect.');
        }
        state.retries = (state.retries ?? 0) + 1;
        executionPath = join(runPath, `retry-${state.retries}`);
        mkdirSync(executionPath);
        // Older runs could record the spec-only commit after a blocked implementation.
        priorCandidate = state.attempts.findLast((attempt) =>
          attempt.implementationStatus === 'ready' && attempt.candidate,
        )?.candidate;
      }
      delete state.error;
      state.status = 'running';
      saveState(runPath, state);
      try {
        state.status = implementAndVerify(root, runPath, executionPath, state, launch, priorCandidate);
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
