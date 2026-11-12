/**
 * Performance budgets for the built MCP server (#815), as the `perf`
 * Playwright project holds the app's. `npm run perf` runs it, and the `mcp-perf`
 * job of ci.yml calls that. It is not part of the unit suite: a stopwatch
 * assertion fails on a loaded runner (docs/testing.md, "A test does not time
 * itself"), so it runs alone, in its own job, with no retry.
 *
 * It starts `dist/index.js` the way a client does, over stdio, and holds three
 * figures to budgets:
 *
 * - cold start: from the start of the process to the first answer of a tool;
 * - `simulate` on a large sample with a config of many regexes;
 * - the peak resident memory of the server process while it runs that
 *   `simulate`. The worker is a thread of this process, so its heap is part of
 *   the figure. Linux only (`VmHWM` in /proc): elsewhere the check is skipped.
 *
 * Each budget is several times the slowest of several local runs, noted beside
 * it, so that CI jitter passes and a regression of kind (a quadratic loop, a
 * worker that loads twice, a result held whole) fails. Each figure goes to the
 * job summary next to its budget, so the drift shows before a budget fails.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));

// Measured 0.2-1.2 s over thirty runs, on a machine that other jobs shared.
const COLD_START_BUDGET_MS = 5_000;
// Measured 2.2-6.1 s per call over eighteen calls, the slow ones with the machine busy.
const SIMULATE_BUDGET_MS = 20_000;
// Measured 350-357 MB over six runs. The worker heap limit is 512 MB, which bounds the rest.
const PEAK_MEMORY_BUDGET_MB = 1_200;

const COLD_RUNS = 5;
const SIMULATE_RUNS = 3;

/** Lines of about 110 characters: most of the 1 MB the tool takes. */
function sample(lines) {
  const methods = ['GET', 'POST', 'PUT', 'DELETE'];
  const out = [];
  for (let i = 0; i < lines; i++) {
    out.push(
      `2026-08-02T10:${String(i % 60).padStart(2, '0')}:00Z host=h${i % 97} m=${methods[i % 4]} s=${200 + (i % 5)} b=${(i * 37) % 9000} u=/p/${i % 500}`,
    );
  }
  return out.join('\n');
}

/** A stanza with many EXTRACTs, each a regex that runs over every event. */
function manyRegexConf(extracts) {
  const lines = ['[perf]', 'SHOULD_LINEMERGE = false', 'TIME_PREFIX = ^', 'TIME_FORMAT = %Y-%m-%dT%H:%M:%S%Z'];
  for (let i = 0; i < extracts; i++) {
    lines.push(`EXTRACT-f${i} = (?<k${i}>\\bh${i % 97}\\b)?.*?\\bs=(?<status${i}>\\d{3})\\s+b=(?<bytes${i}>\\d+)`);
  }
  return lines.join('\n');
}

async function connect() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'inherit' });
  const client = new Client({ name: 'propslab-perf', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

async function simulate(client, raw, propsConf) {
  const result = await client.callTool(
    {
      name: 'simulate',
      arguments: { raw, sourcetype: 'perf', props_conf: propsConf, max_events: 10, timeout_ms: 30_000 },
    },
    undefined,
    { timeout: 60_000 },
  );
  if (result.isError) throw new Error(`simulate failed: ${JSON.stringify(result.content).slice(0, 500)}`);
}

/** The launcher re-execs, so the server is the child of the pid the client holds. */
function serverPid(shimPid) {
  try {
    const children = readFileSync(`/proc/${shimPid}/task/${shimPid}/children`, 'utf8').trim().split(/\s+/);
    return children[0] ? Number(children[0]) : shimPid;
  } catch {
    return shimPid;
  }
}

function peakRssMb(pid) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const match = /^VmHWM:\s+(\d+) kB/m.exec(status);
  if (!match) throw new Error('no VmHWM in /proc status');
  return Number(match[1]) / 1024;
}

const rows = [];
const failures = [];
function record(name, values, budget, unit) {
  const worst = Math.max(...values);
  rows.push({ name, worst, budget, unit });
  console.log(`${name}: ${values.map((v) => Math.round(v)).join(', ')} ${unit} (budget ${budget} ${unit})`);
  if (worst > budget) failures.push(`${name}: ${Math.round(worst)} ${unit} is over the budget of ${budget} ${unit}`);
}

// Cold start: each run is a new process, from before the spawn to the first answer.
const cold = [];
for (let i = 0; i < COLD_RUNS; i++) {
  const start = performance.now();
  const { client } = await connect();
  await simulate(client, 'a=1\n', '[perf]\nSHOULD_LINEMERGE = false\nEXTRACT-a = a=(?<a>\\d)');
  cold.push(performance.now() - start);
  await client.close();
}
record('Cold start, process start to first answer (worst of runs)', cold, COLD_START_BUDGET_MS, 'ms');

// A large sample and many regexes, in one process, so its peak memory is this work's.
const raw = sample(4_500);
const conf = manyRegexConf(60);
const { client, transport } = await connect();
const times = [];
for (let i = 0; i < SIMULATE_RUNS; i++) {
  const start = performance.now();
  await simulate(client, raw, conf);
  times.push(performance.now() - start);
}
record(
  `simulate, ${(raw.length / 1024).toFixed(0)} KB sample, 60 EXTRACTs (worst of runs)`,
  times,
  SIMULATE_BUDGET_MS,
  'ms',
);

if (existsSync('/proc/self/status') && transport.pid) {
  record(
    'Peak memory of the server process, worker included',
    [peakRssMb(serverPid(transport.pid))],
    PEAK_MEMORY_BUDGET_MB,
    'MB',
  );
} else {
  console.warn('Peak memory is measured on Linux only; skipped.');
}
await client.close();

const summary = process.env['GITHUB_STEP_SUMMARY'];
if (summary) {
  const lines = [
    '### MCP server performance budgets',
    '',
    '| Metric | Measured | Budget | Headroom |',
    '| --- | ---: | ---: | ---: |',
    ...rows.map(
      (r) =>
        `| ${r.name} | ${Math.round(r.worst).toLocaleString('en-GB')} ${r.unit} | ${r.budget.toLocaleString('en-GB')} ${r.unit} | ${Math.round((1 - r.worst / r.budget) * 100)}% |`,
    ),
    '',
  ];
  try {
    appendFileSync(summary, `${lines.join('\n')}\n`);
  } catch (error) {
    // A summary that cannot be written must never fail a budget run.
    console.warn(`could not write the job summary: ${String(error)}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`BUDGET EXCEEDED: ${failure}`);
  process.exit(1);
}
