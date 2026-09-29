import type { SplunkEvent, ConfDirective, DirectiveNoOp } from '../types';
import type { NoOpReason } from '../noOpExplainer';
import { isInternalField } from '../utils/internalFields';
import { byClassName } from '../utils/asciiCompare';
import { getMetadataField } from '../utils/metadataFields';
import { getField, hasField, setField } from '../utils/fieldBag';
import {
  unquoteFieldName,
  isQuotedFieldName,
  fieldNameNeedsQuoting,
  fieldQuotingWarning,
} from '../utils/fieldRef';
import { atDirective } from '../parser/provenance';
import type { RunContext, DiagnosticSink } from '../runContext';

interface AliasMapping {
  source: string;
  target: string;
  mode: 'AS' | 'ASNEW';
}

interface CompiledAlias extends AliasMapping {
  directive: ConfDirective;
}

export function applyFieldAliases(
  events: SplunkEvent[],
  directives: ConfDirective[],
  ctx: RunContext,
): SplunkEvent[] {
  const { diagnostics } = ctx;
  const aliasDirectives = directives
    .filter((d) => d.directiveType === 'FIELDALIAS')
    .sort(byClassName);

  if (aliasDirectives.length === 0) return events;

  const aliases = compileAliases(aliasDirectives, diagnostics);
  if (aliases.length === 0) return events;

  const reportedStrippedRefs = new Set<string>();

  return events.map((event) => {
    const newFields = { ...event.fields };
    // Structured, so consumers never have to parse `description` back apart.
    const created: { target: string; source: string }[] = [];

    const noOps: DirectiveNoOp[] = [];
    const noteNoOp = (alias: { directive: ConfDirective }, reason: NoOpReason) => {
      noOps.push({
        directive: alias.directive.key,
        file: 'props.conf',
        line: alias.directive.line,
        phase: 'search-time',
        reason,
      });
    };

    for (const alias of aliases) {
      // `FIELDALIAS-cim = host AS dvc` is one of the most common CIM mappings:
      // the metadata-backed default fields are aliasable like any other.
      const sourceValue = getField(event.fields, alias.source) ?? getMetadataField(event, alias.source);
      if (sourceValue === undefined) {
        maybeWarnStrippedRef(alias, event, diagnostics, reportedStrippedRefs);
        // An alias of a field that does not exist on this event is the FIELDALIAS
        // equivalent of a regex that never matched: nothing appears, and nothing
        // says why.
        noteNoOp(alias, { kind: 'source-key-empty', sourceKey: alias.source });
        continue;
      }

      if (alias.mode === 'ASNEW' && hasField(newFields, alias.target)) {
        noteNoOp(alias, { kind: 'fields-already-set', fields: [alias.target] });
        continue;
      }

      setField(newFields, alias.target, sourceValue);
      created.push({ target: alias.target, source: alias.source });
    }

    const withNoOps = noOps.length > 0 ? { noOps: [...(event.noOps ?? []), ...noOps] } : {};
    if (created.length === 0) return { ...event, ...withNoOps };

    return {
      ...event,
      ...withNoOps,
      fields: newFields,
      processingTrace: [
        ...event.processingTrace,
        {
          processor: 'FIELDALIAS',
          phase: 'search-time' as const,
          description: `Created aliases: ${created.map((a) => `${a.target} (from ${a.source})`).join(', ')}`,
          fieldsAdded: created.map((a) => a.target),
          fieldAliases: created,
        },
      ],
    };
  });
}

function compileAliases(
  aliasDirectives: ConfDirective[],
  diagnostics?: DiagnosticSink,
): CompiledAlias[] {
  const compiled: CompiledAlias[] = [];
  const warnedWildcard = new Set<string>();
  const warnedQuoting = new Set<string>();
  for (const dir of aliasDirectives) {
    for (const a of parseAliases(dir.value)) {
      const source = unquoteFieldName(a.source);
      const target = unquoteFieldName(a.target);

      // Splunk FIELDALIAS does NOT support wildcards (unlike the search-time
      // `rename` command, which is the usual source of this confusion). A `*` in
      // either name means the alias silently does nothing on the search head — so
      // surface that rather than simulating a rename Splunk won't perform.
      if (source.includes('*') || target.includes('*')) {
        const key = `${dir.line}|${a.source}|${a.target}`;
        if (diagnostics && !warnedWildcard.has(key)) {
          warnedWildcard.add(key);
          diagnostics.push({
            level: 'warning',
            message:
              `FIELDALIAS does not support wildcards — "${a.source} ${a.mode} ${a.target}" will not take effect on the search head. ` +
              `Use explicit "orig AS new" pairs, or rename at search time (| rename ${a.source} AS ${a.target}).`,
            file: 'props.conf',
            ...atDirective(dir),
            directiveKey: dir.key,
          });
        }
        continue;
      }

      // A bare field name containing special characters (e.g. a nested-JSON
      // field like `event.field`) won't resolve unquoted on the search head.
      if (diagnostics && !isQuotedFieldName(a.source) && fieldNameNeedsQuoting(source) && !warnedQuoting.has(source)) {
        warnedQuoting.add(source);
        diagnostics.push(
          fieldQuotingWarning(dir, source, 'contains characters that must be quoted to reference a field'),
        );
      }

      compiled.push({ source, target, mode: a.mode, directive: dir });
    }
  }
  return compiled;
}

function maybeWarnStrippedRef(
  alias: CompiledAlias,
  event: SplunkEvent,
  diagnostics: DiagnosticSink | undefined,
  reportedStrippedRefs: Set<string>,
): void {
  if (
    !diagnostics ||
    !alias.source.startsWith('_') ||
    isInternalField(alias.source) ||
    reportedStrippedRefs.has(alias.source)
  ) {
    return;
  }
  const stripped = alias.source.replace(/^_+/, '');
  if (stripped && hasField(event.fields, stripped)) {
    reportedStrippedRefs.add(alias.source);
    diagnostics.push({
      level: 'warning',
      message: `FIELDALIAS references "${alias.source}", but index-time extractions strip leading underscores — Splunk will resolve this as "${stripped}". Update the alias to use "${stripped}".`,
      file: 'props.conf',
      ...atDirective(alias.directive),
      directiveKey: alias.directive.key,
      suggestion: `Replace "${alias.source}" with "${stripped}"`,
    });
  }
}

function parseAliases(value: string): AliasMapping[] {
  const aliases: AliasMapping[] = [];
  // Match `field1 AS field2` / `field1 ASNEW field2`. Each name may be a quoted
  // token ('a.b' or "a.b") so field names with periods/spaces survive as one
  // capture; compileAliases unquotes them. Raw (quoted) text is kept here so the
  // quoting check can tell whether the user already quoted the name.
  const token = `'[^']*'|"[^"]*"|\\S+`;
  const regex = new RegExp(`(${token})\\s+\\b(AS(?:NEW)?)\\b\\s+(${token})`, 'gi');
  let match;

  while ((match = regex.exec(value)) !== null) {
    aliases.push({
      source: match[1] ?? '',
      target: match[3] ?? '',
      mode: (match[2] ?? 'AS').toUpperCase() as 'AS' | 'ASNEW',
    });
  }

  return aliases;
}
