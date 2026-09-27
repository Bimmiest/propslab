/**
 * Static regex check for the validate tool: compile every regex-bearing
 * directive in every stanza, whether or not any event would match the stanza.
 * The engine reports a pattern that will not compile only when a processor
 * reaches it, i.e. only for stanzas that matched the sample; with no sample
 * that is none of them.
 *
 * Compiling a pattern never executes it, but this still runs in the worker
 * with everything else validate does.
 */
import { parseExtractValue } from '../../../src/engine/processors/fieldExtractor';
import { parseSedExpression } from '../../../src/engine/processors/sedCmd';
import { atDirective } from '../../../src/engine/parser/provenance';
import type { ParsedConf, ValidationDiagnostic } from '../../../src/engine/types';
import { validateRegex } from '../../../src/utils/splunkRegex';
import { regexDirectives } from './suspects';

export function lintRegexDirectives(
  propsConf: ParsedConf,
  transformsConf: ParsedConf,
): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  for (const [file, conf] of [
    ['props.conf', propsConf],
    ['transforms.conf', transformsConf],
  ] as const) {
    for (const { dir } of regexDirectives(conf.stanzas, file)) {
      // SEDCMD's pattern sits inside sed syntax; the engine's own parser both
      // extracts and compiles it, and says why when either fails.
      if (dir.directiveType === 'SEDCMD') {
        parseSedExpression(dir.value, dir, diagnostics);
        continue;
      }
      // EXTRACT may end in ` in <field>`, which is not part of the pattern.
      const pattern =
        dir.directiveType === 'EXTRACT' ? parseExtractValue(dir.value).pattern : dir.value.trim();
      const why = validateRegex(pattern);
      if (why === null) continue;
      diagnostics.push({
        level: 'error',
        message:
          `${dir.key} = ${pattern} — ${why.replace(/\.$/, '')}. ` +
          'The simulator skips this directive for every event its stanza applies to.',
        file,
        ...atDirective(dir),
        directiveKey: dir.key,
      });
    }
  }
  return diagnostics;
}
