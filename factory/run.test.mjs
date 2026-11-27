import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from './run.mjs';

const scenario = 'AC-1: Complete mock stream';
const change = 'verify-mock-stream-completion';
const request = 'Verify mock stream completion.';
const entries = new Map([
  ['proposal.md', '# Why\n\nDetect incomplete mock runs.\n\n## What Changes\n\nAdd a smoke check.\n\n## Capabilities\n\n### New Capabilities\n\n- `mock-stream-check`: Verify mock stream completion.\n\n### Modified Capabilities\n\n## Impact\n\nLocal smoke checks.\n'],
  ['design.md', '## Context\n\nThe demo exposes mock SSE.\n\n## Decisions\n\nCheck the terminal event.\n'],
  ['tasks.md', '## 1. Verification\n\n- [ ] 1.1 Add the smoke check.\n'],
  ['specs/mock-stream-check/spec.md', `## ADDED Requirements

### Requirement: Verify mock stream completion
The smoke check SHALL require a matching RUN_FINISHED event.

#### Scenario: ${scenario}
- **WHEN** the requested mock run starts and finishes
- **THEN** the smoke check exits successfully

#### Scenario: AC-2: Truncated mock stream
- **WHEN** the response ends after TEXT_MESSAGE_END
- **THEN** the smoke check exits unsuccessfully and reports missing RUN_FINISHED
`],
]);

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function setup(t, withOpenSpecConfig) {
  mkdirSync('.factory/test-runs', { recursive: true });
  const cwd = mkdtempSync(join(process.cwd(), '.factory', 'test-runs', 'repo-'));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.name', 'Factory Test');
  git(cwd, 'config', 'user.email', 'factory-test@example.invalid');
  if (withOpenSpecConfig) {
    mkdirSync(join(cwd, 'openspec'));
    copyFileSync('openspec/config.yaml', join(cwd, 'openspec', 'config.yaml'));
  }
  writeFileSync(join(cwd, '.gitignore'), '/.factory/\n');
  writeFileSync(join(cwd, 'app.txt'), 'base\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'Base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  t.diagnostic(`Evidence retained in ${cwd}`);
  return { cwd, base };
}

for (const [label, verdicts, expectedStatus, expectedCode] of [
  ['first-pass success', ['pass'], 'passed', 0],
  ['one successful repair', ['defect', 'pass'], 'passed', 0],
  ['second defect', ['defect', 'defect'], 'rejected', 2],
  ['verification blocked', ['blocked'], 'blocked', 1],
  ['implementation blocked', [], 'blocked', 1],
]) {
  test(label, (t) => {
    const { cwd, base } = setup(t, label !== 'first-pass success');
    let runPath;
    let repairCalls = 0;
    let verifierCalls = 0;
    const verifierPaths = new Set();
    const codex = ({ cwd: tree, prompt, output, log }) => {
      writeFileSync(log, prompt);
      if (prompt.startsWith('Draft')) {
        runPath = join(tree, '..');
        writeFileSync(output, JSON.stringify({
          proposal: entries.get('proposal.md'),
          design: entries.get('design.md'),
          tasks: entries.get('tasks.md'),
          specs: [{ capability: 'mock-stream-check', markdown: entries.get('specs/mock-stream-check/spec.md') }],
        }));
      } else if (prompt.startsWith('Independently verify')) {
        assert.ok(!verifierPaths.has(tree));
        verifierPaths.add(tree);
        const candidate = git(tree, 'rev-parse', 'HEAD');
        assert.ok(prompt.includes(candidate));
        const status = verdicts[verifierCalls++];
        assert.ok(status, 'Unexpected extra verifier call');
        const evidence = (name, outcome, exitCode) => ({
          name, outcome, command: 'controlled fixture', exitCode, observed: 'controlled outcome',
        });
        const scenarios = status === 'blocked' ? [] : [
          evidence(scenario, status === 'pass' ? 'pass' : 'fail', status === 'pass' ? 0 : 1),
          evidence('AC-2: Truncated mock stream', 'pass', 1),
        ];
        writeFileSync(output, JSON.stringify({ status, summary: status, scenarios }));
      } else {
        if (repairCalls > 0) assert.match(prompt, /Repair the verified defects/);
        if (!verdicts.length) {
          repairCalls++;
          writeFileSync(output, JSON.stringify({ status: 'blocked', summary: 'Tool unavailable' }));
          return;
        }
        writeFileSync(join(tree, 'app.txt'), `implementation ${++repairCalls}\n`);
        writeFileSync(output, JSON.stringify({ status: 'ready', summary: 'Ready for verification' }));
      }
    };
    const run = (...args) => main(args, { cwd, codex });
    assert.equal(run('plan', '--change', change, '--request', request), 0);
    const state = () => JSON.parse(readFileSync(join(runPath, 'run.json'), 'utf8'));
    const { runId, draftRevision } = state();
    assert.equal(state().status, 'awaiting-approval');
    assert.equal(repairCalls, 0);
    const approve = (commit) => run('approve', '--run', runId, '--revision', commit);
    const design = join(runPath, 'draft', 'openspec', 'changes', change, 'design.md');
    writeFileSync(design, readFileSync(design, 'utf8') + '\nReview edit.\n');
    assert.throws(() => approve(draftRevision), /latest clean draft/);
    assert.equal(run('snapshot', '--run', runId), 0);
    assert.notEqual(state().draftRevision, draftRevision);
    assert.throws(() => approve(draftRevision), /latest clean draft/);
    assert.equal(repairCalls, 0);
    assert.equal(approve(state().draftRevision), expectedCode);
    assert.equal(state().status, expectedStatus);
    assert.equal(state().attempts.length, verdicts.length || 1);
    assert.equal(repairCalls, verdicts.length || 1);
    assert.equal(verifierCalls, verdicts.length);
    assert.deepEqual(state().attempts.map((attempt) => attempt.status), verdicts.length ? verdicts : ['blocked']);
    assert.equal(new Set(state().attempts.flatMap((attempt) => attempt.candidate ?? [])).size, verdicts.length);
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), base);
    assert.equal(git(cwd, 'status', '--porcelain'), '');
  });
}
