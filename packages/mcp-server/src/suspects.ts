/**
 * Static analysis used to make a simulate timeout repairable instead of a
 * blind retry: enumerate every regex-valued directive in the conf inputs and
 * flag the structurally ReDoS-prone ones.
 *
 * Runs in the sandbox worker, before the pipeline, and the list is posted to
 * the server ahead of the run (simulateWorker.ts). The server keeps the last
 * list it was sent and reports it if the run then times out; it never parses
 * the caller's conf on its own thread, where nothing bounds how long that
 * takes. A run that times out before the list is posted — still parsing the
 * conf — reports no list, and says so.
 *
 * Patterns run on PCRE2, whose match limits bound each match, so a timeout is
 * the sum of many bounded matches rather than one runaway. `hasReDoSRisk` is a
 * structural, advisory heuristic for which pattern is likeliest to be doing
 * that work: it cannot see alternation-overlap forms like `(a|aa)+`, so an
 * empty suspect list does not prove the conf innocent — the timeout error
 * says so.
 */
import { parseConf } from '../../../src/engine/parser/confParser';
import { hasReDoSRisk } from '../../../src/utils/redosHeuristic';
import type { ConfInput } from '../../../src/engine/types';
import { directivePatterns } from './directivePatterns';
import { elementBytes, fitting, MAX_PAYLOAD_BYTES } from './responseBudget';

export interface RegexSuspect {
  file: 'props.conf' | 'transforms.conf';
  stanza: string;
  key: string;
  line: number;
  layer?: string;
  pattern: string;
  /** A regex inside an eval expression: the function it is passed to, e.g. `match()`. */
  via?: string;
  /** True when the engine's structural ReDoS heuristic flags the pattern. */
  redos_risk: boolean;
}

/**
 * The suspect list as the worker posts it: flagged patterns first, cut to
 * what one response can carry, with the length before the cut.
 */
export interface SuspectList {
  suspects: RegexSuspect[];
  total: number;
}

/**
 * Every regex every directive in the conf runs, one suspect each — the same
 * patterns validate compiles (directivePatterns.ts), so an `EXTRACT … in
 * <field>` lists its pattern without the suffix, a SEDCMD its `s///` regex,
 * and an eval expression each literal regex it passes to `match()`,
 * `replace()` or `mvfind()` (`via` names the function).
 */
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
    for (const stanza of parseConf(input, file).stanzas) {
      for (const dir of stanza.directives) {
        for (const { pattern, fn } of directivePatterns(dir, file)) {
          suspects.push({
            file,
            stanza: stanza.name,
            key: dir.key,
            line: dir.line,
            ...(dir.layer !== undefined ? { layer: dir.layer } : {}),
            pattern,
            ...(fn !== undefined ? { via: `${fn}()` } : {}),
            redos_risk: hasReDoSRisk(pattern),
          });
        }
      }
    }
  }

  // Flagged patterns first — they are what the agent should repair.
  return suspects.sort((a, b) => Number(b.redos_risk) - Number(a.redos_risk));
}

/**
 * `collectRegexSuspects`, cut to the response budget in the worker, so what
 * crosses to the server's thread is bounded however many patterns the conf
 * holds. The timeout error cuts it again, exactly, around its other fields.
 */
export function boundedRegexSuspects(propsConf: ConfInput, transformsConf: ConfInput): SuspectList {
  const all = collectRegexSuspects(propsConf, transformsConf);
  return {
    suspects: all.slice(0, fitting(all, elementBytes, MAX_PAYLOAD_BYTES)),
    total: all.length,
  };
}
