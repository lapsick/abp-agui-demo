import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

function readEvents(stream) {
  return stream.replace(/\r\n?/g, '\n').split('\n\n').slice(0, -1).flatMap((frame) => {
    const data = frame.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    return data.length ? [JSON.parse(data.join('\n'))] : [];
  });
}

async function check() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: 'http://localhost:5080' },
      'run-id': { type: 'string', default: randomUUID() },
    },
  });
  const runId = values['run-id'];
  if (!runId.trim()) throw new Error('Provide a nonempty run ID.');
  const threadId = randomUUID();
  const signal = AbortSignal.timeout(15_000);
  const status = await fetch(new URL('/api/status', values.url), { signal });
  if (!status.ok || (await status.json()).mode !== 'mock') {
    throw new Error('Expected /api/status to report mock mode.');
  }
  const response = await fetch(new URL('/api/agent', values.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ threadId, runId }),
    signal,
  });
  if (response.status !== 200 || !/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error(`Expected HTTP 200 with an SSE response from /api/agent. Received HTTP ${response.status}.`);
  }
  const events = readEvents(await response.text());
  if (events.some((event) => event?.type === 'RUN_ERROR')) throw new Error(`RUN_ERROR received for ${runId}.`);
  const matches = (event, type) => event?.type === type && event.runId === runId && event.threadId === threadId;
  const started = events.findIndex((event) => matches(event, 'RUN_STARTED'));
  if (started < 0) throw new Error(`Missing matching RUN_STARTED for ${runId}.`);
  if (!events.slice(started + 1).some((event) => matches(event, 'RUN_FINISHED'))) {
    throw new Error(`Missing matching RUN_FINISHED for ${runId}.`);
  }
  console.log(`RUN_STARTED and RUN_FINISHED matched run ${runId}.`);
}

try {
  await check();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
