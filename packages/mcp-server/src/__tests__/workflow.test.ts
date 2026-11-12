import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getDirectivesForFile } from '../../../../src/engine/directiveRegistry';
import { createServer, SERVER_INSTRUCTIONS } from '../server';
import { jsonResponseBytes, MAX_PAYLOAD_BYTES } from '../responseBudget';
import { DIRECTIVE_REGISTRY_URI, directiveRegistryJson, workflowPromptText } from '../workflow';

/**
 * The workflow prompt and the registry resource (#813), through a real SDK
 * client: neither needs a worker, so no built bundle is involved.
 */
let client: Client;
let close: () => Promise<void>;

beforeEach(async () => {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'propslab-workflow', version: '0.0.0' });
  await client.connect(clientTransport);
  close = async () => {
    await client.close();
    await server.close();
  };
});

afterEach(async () => {
  await close();
});

const promptText = async (args: Record<string, string> = {}) => {
  const { messages } = await client.getPrompt({ name: 'draft_simulate_fix', arguments: args });
  expect(messages).toHaveLength(1);
  const [message] = messages;
  expect(message?.role).toBe('user');
  if (message?.content.type !== 'text') throw new Error('expected a text message');
  return message.content.text;
};

describe('the draft_simulate_fix prompt', () => {
  it('is listed, with its three optional arguments', async () => {
    const { prompts } = await client.listPrompts();
    const prompt = prompts.find((p) => p.name === 'draft_simulate_fix');
    expect(prompt?.title).toBe('Draft, simulate and fix a props.conf');
    expect(prompt?.arguments?.map((a) => [a.name, a.required ?? false])).toEqual([
      ['sample', false],
      ['sourcetype', false],
      ['goal', false],
    ]);
  });

  it('puts the sample, the sourcetype and the goal into the workflow', async () => {
    const text = await promptText({
      sample: '10.0.0.1 - - [02/Aug/2026:10:15:00 +0000] "GET /a HTTP/1.1" 200 123',
      sourcetype: 'access_log',
      goal: 'extract status',
    });
    expect(text).toContain('```\n10.0.0.1 - - [02/Aug/2026:10:15:00 +0000] "GET /a HTTP/1.1" 200 123\n```');
    expect(text).toContain('Sourcetype: access_log.');
    expect(text).toContain('Goal: extract status');
    expect(text).not.toMatch(/Ask the user for sample events/);
  });

  it('asks for a sample rather than invent one when none is given', async () => {
    const text = await promptText();
    expect(text).toMatch(/Ask the user for sample events first.*Do not invent them\./);
    expect(text).toMatch(/Choose a sourcetype name\./);
    expect(text).toMatch(/^Goal: one event for each record/m);
  });

  it('orders the steps lookup, validate, simulate, fix, report', async () => {
    const text = await promptText();
    const at = (step: string) => text.indexOf(step);
    expect(at('lookup_directive')).toBeGreaterThan(-1);
    expect(at(DIRECTIVE_REGISTRY_URI)).toBeGreaterThan(-1);
    expect(at('lookup_directive')).toBeLessThan(at('Call validate'));
    expect(at('Call validate')).toBeLessThan(at('Call simulate'));
    expect(at('Call simulate')).toBeLessThan(at('4. Fix.'));
    expect(at('4. Fix.')).toBeLessThan(at('5. Report.'));
    expect(text).toContain('processingTrace');
  });

  it('tells the agent to report each directive the simulation does not honour', async () => {
    const text = await promptText();
    const report = text.slice(text.indexOf('5. Report.'));
    expect(report).toMatch(/list each directive in the conf that the simulation does not honour/);
    expect(report).toMatch(/support level is documented or ignored/);
    expect(report).toMatch(/a diagnostic says the simulator does not honour/);
    expect(report).toMatch(/If there is no such directive, say so\./);
  });

  it('is the same text the server builds directly', async () => {
    expect(await promptText({ sourcetype: 'st' })).toBe(workflowPromptText({ sourcetype: 'st' }));
  });

  it('is named in the server instructions', () => {
    expect(SERVER_INSTRUCTIONS).toContain('draft_simulate_fix');
    expect(SERVER_INSTRUCTIONS).toContain(DIRECTIVE_REGISTRY_URI);
  });
});

describe('the directive registry resource', () => {
  it('is listed as JSON', async () => {
    const { resources } = await client.listResources();
    expect(resources).toContainEqual(
      expect.objectContaining({
        uri: DIRECTIVE_REGISTRY_URI,
        name: 'directive_registry',
        mimeType: 'application/json',
      }),
    );
  });

  it('holds every registry entry for each file, each with its support level', async () => {
    const { contents } = await client.readResource({ uri: DIRECTIVE_REGISTRY_URI });
    expect(contents).toHaveLength(1);
    const [content] = contents;
    expect(content).toMatchObject({ uri: DIRECTIVE_REGISTRY_URI, mimeType: 'application/json' });
    if (content === undefined || !('text' in content)) throw new Error('expected a text resource');
    const registry = JSON.parse(content.text) as Record<string, unknown>;

    for (const file of ['props.conf', 'transforms.conf'] as const) {
      const entries = registry[file] as { key: string; support: string }[];
      expect(entries.map((d) => d.key)).toEqual(getDirectivesForFile(file).map((d) => d.key));
      for (const entry of entries) expect(['simulated', 'documented', 'ignored'], entry.key).toContain(entry.support);
    }
    const props = registry['props.conf'] as { key: string; support: string; supportNote?: string }[];
    expect(props.find((d) => d.key === 'LINE_BREAKER')).toMatchObject({ support: 'simulated', valueType: 'regex' });
    // A directive outside the simulation carries the reason with it.
    const outside = props.filter((d) => d.support !== 'simulated');
    expect(outside.length).toBeGreaterThan(0);
    for (const d of outside) expect(d.supportNote, d.key).toBeTruthy();
    expect(Object.keys(registry['supportLevels'] as object)).toEqual(['simulated', 'documented', 'ignored']);
  });

  it('fits the response budget whole', () => {
    expect(jsonResponseBytes(directiveRegistryJson())).toBeLessThan(MAX_PAYLOAD_BYTES);
  });

  it('leaves lookup_directive in place for clients without resources', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('lookup_directive');
  });
});
