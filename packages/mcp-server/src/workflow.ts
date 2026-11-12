/**
 * The draft–simulate–fix workflow as an MCP prompt, and the directive
 * registry as an MCP resource (#813). The tools stay the whole interface for
 * a client without prompts or resources: the prompt says what the README says
 * about using them, and `lookup_directive` answers what the resource holds.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDirectivesForFile } from 'propslab-engine';

export const DIRECTIVE_REGISTRY_URI = 'propslab://directives';

/**
 * What each support level means for an agent, beside the entries, so the
 * resource reads on its own. From the classification in
 * `src/engine/directiveSupport.ts`.
 */
const SUPPORT_LEVELS = {
  simulated: 'The simulator implements it, and tests assert its behaviour. A simulate run shows its effect.',
  documented:
    'Known on purpose, but outside the simulation: it belongs to a layer the simulator has no access to, ' +
    'or it has no effect on the output. A simulate run does not show its effect; supportNote says why.',
  ignored:
    'Should be simulated, and is not yet; supportIssue names the issue. A simulate run gives a wrong ' +
    'answer for it.',
} as const;

/**
 * The resource's JSON: every registry entry for each file, with its support
 * level, the note on it and its issue. The whole registry is under 100 KB, far
 * inside the response budget (responseBudget.ts), so nothing is cut.
 */
export function directiveRegistryJson(): string {
  return JSON.stringify({
    supportLevels: SUPPORT_LEVELS,
    'props.conf': getDirectivesForFile('props.conf'),
    'transforms.conf': getDirectivesForFile('transforms.conf'),
  });
}

export const workflowArgsShape = {
  sample: z.string().optional().describe('Sample events, as raw lines in the form they reach the indexer.'),
  sourcetype: z.string().optional().describe('The sourcetype of the sample, which names the props.conf stanza.'),
  goal: z
    .string()
    .optional()
    .describe('What the config must do, e.g. "one event per line, _time from the bracketed date, extract status".'),
};

type WorkflowArgs = { [K in keyof typeof workflowArgsShape]?: string | undefined };

/** The prompt's one user message. The steps follow the server's instructions. */
export function workflowPromptText(args: WorkflowArgs): string {
  const sample =
    args.sample === undefined
      ? 'Ask the user for sample events first: raw lines, in the form they reach the indexer. Do not invent them.'
      : `Sample events:\n\n\`\`\`\n${args.sample}\n\`\`\``;
  const sourcetype =
    args.sourcetype === undefined
      ? 'Choose a sourcetype name. Use it for the props.conf stanza and in each simulate call.'
      : `Sourcetype: ${args.sourcetype}. Use it for the props.conf stanza and in each simulate call.`;
  const goal =
    args.goal === undefined
      ? 'Goal: one event for each record in the sample, the correct _time for each event, and the fields a search needs.'
      : `Goal: ${args.goal}`;
  return [
    'Write a Splunk props.conf, and a transforms.conf if the goal needs one. Check what it does with the ' +
      'propslab tools; do not predict it.',
    '',
    goal,
    sourcetype,
    sample,
    '',
    '1. Draft. For each directive you use, read its entry with lookup_directive, or in the resource ' +
      `${DIRECTIVE_REGISTRY_URI}. Note its support level: simulated, documented or ignored.`,
    '2. Validate. Call validate with the draft. Fix each parse error, unknown or mis-cased key, value of the ' +
      'wrong type, missing transforms stanza and regex that does not compile. Then validate again.',
    '3. Simulate. Call simulate with the sample, the sourcetype and the draft. For each event, read _time, ' +
      'fields, indexedFields and processingTrace, which names each processor that changed the event. Read the ' +
      'diagnostics too.',
    '4. Fix. Where an event is different from the goal, find the cause in its processingTrace, change the conf, ' +
      'and simulate again. Continue until the events agree with the goal.',
    '5. Report. Give the final conf files and what the last simulation showed. Then list each directive in the ' +
      'conf that the simulation does not honour: each one whose support level is documented or ignored, and ' +
      'each one that a diagnostic says the simulator does not honour. For each, say that the simulation did not ' +
      'verify its effect, and give the reason from its supportNote. If there is no such directive, say so.',
  ].join('\n');
}

export function registerWorkflow(server: McpServer): void {
  server.registerPrompt(
    'draft_simulate_fix',
    {
      title: 'Draft, simulate and fix a props.conf',
      description:
        'Write a props.conf (and transforms.conf) for sample data, validate it, simulate it on the sample, ' +
        'fix it from the processingTrace, and report each directive that the simulation does not honour.',
      argsSchema: workflowArgsShape,
    },
    (args) => ({
      messages: [{ role: 'user', content: { type: 'text', text: workflowPromptText(args) } }],
    }),
  );

  server.registerResource(
    'directive_registry',
    DIRECTIVE_REGISTRY_URI,
    {
      title: 'Directive registry',
      description:
        'Every props.conf and transforms.conf directive the simulator knows: description, example, default, ' +
        'value type, phase, and its support level (simulated, documented or ignored) with the reason. The ' +
        'same data as lookup_directive, in one read.',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: directiveRegistryJson() }],
    }),
  );
}
