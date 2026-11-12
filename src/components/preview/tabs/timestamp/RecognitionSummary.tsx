import type { TimeConfig } from 'propslab-engine';
import { useApplyDirective } from '../shared/useApplyDirective';
import { recognisedDirectives, type RecognitionSummary } from './timestampLogic';

const events = (n: number) => `${n} ${n === 1 ? 'event' : 'events'}`;

/**
 * What automatic recognition did, for a config with no TIME_FORMAT (#898):
 * the format most events were read with, the counts, and the button that
 * writes that format down. Only the most common format gets the button: a
 * stanza holds one TIME_FORMAT.
 */
export function RecognitionSummaryPanel({ summary, config }: { summary: RecognitionSummary; config: TimeConfig }) {
  const [headline, ...others] = summary.formats;
  return (
    <section
      className="flex-shrink-0 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-xs space-y-1"
      aria-label="Automatic timestamp recognition"
    >
      {headline ? (
        <div className="text-[var(--color-text-primary)]">
          Auto-recognized timestamp format{' '}
          <code className="font-mono font-medium px-1 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-success)]">
            {headline.format}
          </code>{' '}
          <span className="text-[var(--color-text-muted)]">({events(headline.count)})</span>
        </div>
      ) : (
        <div className="text-[var(--color-text-primary)]">
          No TIME_FORMAT is set, and automatic recognition found no timestamp in any event.
        </div>
      )}
      <div className="text-[var(--color-text-muted)]">
        {events(summary.recognised)} recognized · {events(summary.fallback)} with a _time not read from the event text
      </div>
      {others.length > 0 && (
        <div className="text-[var(--color-text-muted)]">
          Also recognized:{' '}
          {others.map((f, i) => (
            <span key={f.format}>
              {i > 0 && ', '}
              <code className="font-mono px-1 rounded bg-[var(--color-bg-tertiary)]">{f.format}</code> (
              {events(f.count)})
            </span>
          ))}
        </div>
      )}
      {headline && <WriteTimeFormat directives={recognisedDirectives(headline, config)} />}
    </section>
  );
}

/**
 * Writes the directives into the stanza that applies to the run's events,
 * through the path that the event menu's scaffolds and Create FIELDALIAS use.
 */
function WriteTimeFormat({ directives }: { directives: { key: string; value: string }[] }) {
  const { stanzaFor, apply } = useApplyDirective();
  return (
    <div className="flex flex-wrap items-center gap-2 pt-0.5">
      <button
        type="button"
        onClick={() => {
          for (const { key, value } of directives) apply(key, value);
        }}
        className="flex-shrink-0 px-2 py-1 text-xs rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer"
      >
        Write this as TIME_FORMAT
      </button>
      <span className="text-[var(--color-text-muted)]">
        Adds to <code className="font-mono">[{stanzaFor('TIME_FORMAT')}]</code>:{' '}
        <code className="font-mono text-[var(--color-text-primary)]" data-testid="time-format-directives">
          {directives.map((d) => `${d.key} = ${d.value}`).join('  ')}
        </code>
      </span>
    </div>
  );
}
