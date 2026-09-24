// ---------------------------------------------------------------------------
// EffectiveConfigTab.tsx
// What `splunk btool props list <sourcetype> --debug` prints, for the metadata
// currently configured (#86).
//
// The simulator has always computed this to decide what to run; it just never
// showed it. The row that earns the panel is the contested one -- a directive
// written in one stanza and silently beaten by another -- because that is a
// wrong preview whose cause is invisible in the editor.
// ---------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import { parseConf } from '../../../engine/parser/confParser';
import { resolveStanzasForEvent } from '../../../engine/parser/stanzaMatcher';
import {
  resolveEffectiveConfig,
  type EffectiveDirective,
} from '../../../engine/parser/effectiveConfig';
import { getEditor } from '../../editor/editorRegistry';
import { Icon } from '../../ui/Icon';

/** Jump the props.conf editor to a line, the way the validation list does. */
function jumpTo(line: number): void {
  const ed = getEditor('props.conf');
  if (!ed) return;
  ed.focus();
  requestAnimationFrame(() => {
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.revealLineInCenter(line);
  });
}

const STANZA_TYPE_LABEL: Record<EffectiveDirective['stanza']['type'], string> = {
  source: 'source::',
  host: 'host::',
  sourcetype: 'sourcetype',
  default: 'default',
};

function StanzaBadge({ type }: { type: EffectiveDirective['stanza']['type'] }) {
  return (
    <span className="text-[10px] uppercase tracking-wide px-1 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
      {STANZA_TYPE_LABEL[type]}
    </span>
  );
}

function DirectiveRow({ directive }: { directive: EffectiveDirective }) {
  const [expanded, setExpanded] = useState(false);
  const contested = directive.overriddenByStanza.length > 0;

  return (
    <div className="border-b border-[var(--color-border-subtle)] last:border-b-0">
      <div className="flex items-start gap-2 px-3 py-2 hover:bg-[var(--color-bg-tertiary)] transition-colors">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs font-mono text-[var(--color-text-primary)]">{directive.key}</span>
            <span className="text-xs font-mono text-[var(--color-text-secondary)] truncate">
              = {directive.value}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <StanzaBadge type={directive.stanza.type} />
            <button
              type="button"
              onClick={() => jumpTo(directive.line)}
              className="text-xs font-mono text-[var(--color-accent)] cursor-pointer hover:underline bg-transparent border-none p-0"
            >
              [{directive.stanza.name}]:{directive.line}
            </button>
            {directive.layer !== undefined && (
              <span className="text-xs text-[var(--color-text-muted)]">{directive.layer}</span>
            )}
            {contested && (
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                aria-expanded={expanded}
                className="text-xs text-[var(--color-warning)] cursor-pointer hover:underline bg-transparent border-none p-0"
              >
                overrides {directive.overriddenByStanza.length} other
                {directive.overriddenByStanza.length !== 1 ? 's' : ''}
              </button>
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <ul className="pl-6 pr-3 pb-2 space-y-1">
          {directive.overriddenByStanza.map((loser) => (
            <li
              key={`${loser.name}-${loser.directiveLine}-${loser.layer ?? ''}`}
              className="flex items-center gap-2 flex-wrap"
            >
              <Icon name="x" className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />
              <span className="text-xs font-mono text-[var(--color-text-muted)] line-through">
                {directive.key} = {loser.value}
              </span>
              <StanzaBadge type={loser.type} />
              <button
                type="button"
                onClick={() => jumpTo(loser.directiveLine)}
                className="text-xs font-mono text-[var(--color-accent)] cursor-pointer hover:underline bg-transparent border-none p-0"
              >
                [{loser.name}]:{loser.directiveLine}
              </button>
              {loser.layer !== undefined && (
                <span className="text-xs text-[var(--color-text-muted)]">{loser.layer}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function EffectiveConfigTab() {
  const propsConf = useAppStore((s) => s.propsConf);
  const metadata = useAppStore((s) => s.metadata);
  const [contestedOnly, setContestedOnly] = useState(false);

  // Resolved with `resolveStanzasForEvent`, as the pipeline does, so an
  // input-time `sourcetype =` in a [source::] or [host::] stanza brings in the
  // stanza it assigns. `matchStanzas` alone listed the settings of the
  // sourcetype being replaced, which the preview never applied (#328).
  const { effective, assignedSourcetype } = useMemo(() => {
    if (propsConf.trim() === '') return { effective: [], assignedSourcetype: undefined };
    const { stanzas } = parseConf(propsConf, 'props.conf');
    const resolved = resolveStanzasForEvent(stanzas, metadata);
    return { effective: resolveEffectiveConfig(resolved.stanzas), assignedSourcetype: resolved.assignedSourcetype };
  }, [propsConf, metadata]);

  const contestedCount = effective.filter((d) => d.overriddenByStanza.length > 0).length;
  const shown = contestedOnly ? effective.filter((d) => d.overriddenByStanza.length > 0) : effective;

  if (effective.length === 0) {
    return (
      <div className="h-full overflow-auto p-3">
        <p className="text-xs text-[var(--color-text-muted)]">
          {propsConf.trim() === ''
            ? 'No props.conf yet.'
            : `No stanza in props.conf matches sourcetype "${assignedSourcetype ?? metadata.sourcetype}", source "${metadata.source}" or host "${metadata.host}".`}
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border-subtle)]">
        <span className="text-xs text-[var(--color-text-muted)]">
          {effective.length} effective directive{effective.length !== 1 ? 's' : ''}
          {contestedCount > 0 && `, ${contestedCount} contested`}
        </span>
        {contestedCount > 0 && (
          <button
            type="button"
            onClick={() => setContestedOnly(!contestedOnly)}
            className="text-xs text-[var(--color-accent)] hover:underline cursor-pointer bg-transparent border-none p-0"
          >
            {contestedOnly ? 'Show all' : 'Show contested only'}
          </button>
        )}
      </div>

      {assignedSourcetype !== undefined && (
        <p className="px-3 py-2 text-xs text-[var(--color-text-muted)] border-b border-[var(--color-border-subtle)]">
          Sourcetype assigned at input: <span className="font-mono">{metadata.sourcetype}</span> →{' '}
          <span className="font-mono text-[var(--color-text-primary)]">{assignedSourcetype}</span>. Stanzas are resolved
          against the assigned sourcetype.
        </p>
      )}

      <div>
        {shown.map((directive) => (
          <DirectiveRow key={`${directive.stanza.name}-${directive.key}`} directive={directive} />
        ))}
      </div>

      <p className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
        Resolved for the metadata above, the same way the preview resolves it. Stanza precedence is
        source:: over host:: over sourcetype over default.
      </p>
    </div>
  );
}
