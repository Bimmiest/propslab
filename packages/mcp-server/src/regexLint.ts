/**
 * Static regex check for the validate tool: compile every regex every
 * directive runs, in every stanza, whether or not any event would match the
 * stanza. The engine reports a pattern that will not compile only when a
 * processor reaches it, i.e. only for stanzas that matched the sample; with
 * no sample that is none of them.
 *
 * Which regexes a directive runs is directivePatterns.ts's answer, shared
 * with the timeout's suspect list so the two agree. Compiling a pattern never
 * executes it, but this still runs in the worker with everything else
 * validate does.
 */
import { parseSedExpression } from '../../../src/engine/processors/sedCmd';
import { regexFailureMessage } from '../../../src/engine/processors/eval/builtins';
import { atDirective } from '../../../src/engine/parser/provenance';
import type { ParsedConf, ValidationDiagnostic } from '../../../src/engine/types';
import { validateRegex } from '../../../src/utils/splunkRegex';
import { directivePatterns } from './directivePatterns';

export function lintRegexDirectives(propsConf: ParsedConf, transformsConf: ParsedConf): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  for (const [file, conf] of [
    ['props.conf', propsConf],
    ['transforms.conf', transformsConf],
  ] as const) {
    for (const stanza of conf.stanzas) {
      for (const dir of stanza.directives) {
        // SEDCMD's pattern sits inside sed syntax; the engine's own parser
        // both extracts and compiles it, and says why when either fails —
        // including a value that is not a sed expression at all.
        if (dir.directiveType === 'SEDCMD') {
          if (dir.value.trim()) parseSedExpression(dir.value, dir, diagnostics);
          continue;
        }
        for (const { pattern, fn } of directivePatterns(dir, file)) {
          const why = validateRegex(pattern);
          if (why === null) continue;
          diagnostics.push({
            level: 'error',
            message:
              fn === undefined
                ? `${dir.key} = ${pattern} — ${why.replace(/\.$/, '')}. ` +
                  'The simulator skips this directive for every event its stanza applies to.'
                : `${dir.key}: ${regexFailureMessage(fn, pattern)}`,
            file,
            ...atDirective(dir),
            directiveKey: dir.key,
          });
        }
      }
    }
  }
  return diagnostics;
}
