/**
 * Static analysis used to make a simulate timeout repairable instead of a
 * blind retry: enumerate every regex-valued directive in the conf inputs and
 * flag the structurally ReDoS-prone ones. Runs in the server process — it
 * parses conf text and inspects patterns but never EXECUTES them, so it is
 * safe outside the worker sandbox.
 *
 * `hasReDoSRisk` is the engine's own heuristic and is structural: it
 * documents that it cannot see alternation-overlap forms like `(a|aa)+`, so
 * an empty suspect list does not prove the conf innocent — the timeout error
 * says so.
 */
import { parseConf } from '../../../src/engine/parser/confParser';
import { getDirectiveInfo } from '../../../src/engine/directiveRegistry';
import { hasReDoSRisk } from '../../../src/utils/splunkRegex';
import type { ConfDirective, ConfInput, ConfStanza } from '../../../src/engine/types';

export interface RegexSuspect {
  file: 'props.conf' | 'transforms.conf';
  stanza: string;
  key: string;
  line: number;
  layer?: string;
  pattern: string;
  /** True when the engine's structural ReDoS heuristic flags the pattern. */
  redos_risk: boolean;
}

/**
 * Every directive in `stanzas` whose non-empty value is a regex the engine
 * compiles. Shared with validate's static regex check (regexLint.ts), so the
 * two agree on what counts as regex-bearing.
 */
export function* regexDirectives(
  stanzas: ConfStanza[],
  file: 'props.conf' | 'transforms.conf',
): Generator<{ stanza: ConfStanza; dir: ConfDirective }> {
  for (const stanza of stanzas) {
    for (const dir of stanza.directives) {
      const baseKey = dir.className ? dir.directiveType : dir.key;
      const info = getDirectiveInfo(baseKey, file);
      // SEDCMD's value embeds its regex in sed syntax rather than being
      // typed `regex` in the registry; it executes against `_raw` all the
      // same, so it belongs on the list.
      const carriesRegex = info?.valueType === 'regex' || dir.directiveType === 'SEDCMD';
      if (carriesRegex && dir.value.trim()) yield { stanza, dir };
    }
  }
}

export function collectRegexSuspects(
  propsConf: ConfInput,
  transformsConf: ConfInput,
): RegexSuspect[] {
  const suspects: RegexSuspect[] = [];
  const files: ['props.conf' | 'transforms.conf', ConfInput][] = [
    ['props.conf', propsConf],
    ['transforms.conf', transformsConf],
  ];

  for (const [file, input] of files) {
    for (const { stanza, dir } of regexDirectives(parseConf(input, file).stanzas, file)) {
      const pattern = dir.value.trim();
      suspects.push({
        file,
        stanza: stanza.name,
        key: dir.key,
        line: dir.line,
        ...(dir.layer !== undefined ? { layer: dir.layer } : {}),
        pattern,
        redos_risk: hasReDoSRisk(pattern),
      });
    }
  }

  // Flagged patterns first — they are what the agent should repair.
  return suspects.sort((a, b) => Number(b.redos_risk) - Number(a.redos_risk));
}
