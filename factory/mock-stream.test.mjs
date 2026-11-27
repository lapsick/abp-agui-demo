import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const execute = promisify(execFile);
const checker = fileURLToPath(new URL('../scripts/check-mock-stream.mjs', import.meta.url));
const upstream = process.argv[2] === '--url' ? process.argv[3] : null;

test('mock stream completion requires a matching start and finish', async () => {
  let fullStream;
  let replay;
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/api/status') {
        const body = upstream
          ? await (await fetch(new URL(request.url, upstream))).text()
          : JSON.stringify({ mode: 'mock' });
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      if (!replay) {
        if (upstream) {
          const result = await fetch(new URL('/api/agent', upstream), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
          });
          assert.equal(result.status, 200);
          fullStream = await result.text();
        } else {
          const { threadId, runId } = JSON.parse(body);
          fullStream = ['RUN_STARTED', 'TEXT_MESSAGE_END', 'RUN_FINISHED']
            .map((type) => `data: ${JSON.stringify({ type, threadId, runId })}\n\n`).join('');
        }
      }
      let stream = fullStream;
      if (replay) {
        const { threadId } = JSON.parse(body);
        const originalThread = JSON.parse(/^data: (.+)$/m.exec(fullStream)[1]).threadId;
        stream = fullStream.replaceAll(originalThread, threadId)
          .replace(/^data: ([^\r\n]+)\r?\n\r?\n/gm, (frame, payload) => {
            const event = JSON.parse(payload);
            if (replay === 'truncated' && event.type === 'RUN_FINISHED') return '';
            if (event.type !== replay) return frame;
            event.runId = 'different-run';
            return `data: ${JSON.stringify(event)}\n\n`;
          });
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(stream);
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const args = [checker, '--run-id', 'factory-smoke-test', '--url', `http://127.0.0.1:${server.address().port}`];
    const result = await execute(process.execPath, args);
    assert.match(result.stdout, /RUN_STARTED and RUN_FINISHED matched run factory-smoke-test/);
    assert.match(fullStream, /"type"\s*:\s*"TEXT_MESSAGE_END"/);
    for (const [mode, stderr] of [
      ['truncated', /Missing matching RUN_FINISHED for factory-smoke-test/],
      ['RUN_STARTED', /Missing matching RUN_STARTED for factory-smoke-test/],
      ['RUN_FINISHED', /Missing matching RUN_FINISHED for factory-smoke-test/],
    ]) {
      replay = mode;
      await assert.rejects(execute(process.execPath, args), { code: 1, stderr });
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
