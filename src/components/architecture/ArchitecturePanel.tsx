import { useMemo } from 'react';
import { countDirectives, directiveTiers, TIER_ORDER, type PlacedDirective, type TierId } from './directiveTiers';
import type { PipelineInputs } from '../preview/tabs/shared/usePipelineInputs';
import { revealInEditor } from '../editor/revealInEditor';

/**
 * Where each part of the configuration runs. Drawn from the props.conf and
 * transforms.conf the pipeline last ran with (`usePipelineInputs`), like the
 * other output tabs: debounced as the pipeline is, and frozen in manual-apply
 * mode, rather than re-parsed on every keystroke.
 */
export function ArchitecturePanel({ inputs, embedded }: { inputs: PipelineInputs; embedded?: boolean }) {
  const { propsConf } = inputs;
  const tiers = useMemo(() => directiveTiers(propsConf), [propsConf]);
  const parsingCount = countDirectives(tiers.byTier['heavy-forwarder']);
  const anyDirective = TIER_ORDER.some((t) => tiers.byTier[t].length > 0) || tiers.unknown.length > 0;

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-primary)]">
      {!embedded && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <svg
            className="w-4 h-4 text-[var(--color-accent)]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
            />
          </svg>
          <span className="text-sm font-medium text-[var(--color-text-primary)]">Architecture</span>
        </div>
      )}
      <div className="flex-1 overflow-auto p-3">
        <div className="mx-auto w-full max-w-xl flex flex-col items-stretch gap-2">
          {!anyDirective && (
            <p className="text-xs text-[var(--color-text-muted)]">
              Add props.conf directives to see the tier where each one runs.
            </p>
          )}
          {TIER_ORDER.map((tier, i) => {
            const groups = tiers.byTier[tier];
            // The indexer parses when no heavy forwarder is on the path, so the
            // directives of the parsing tier use it too.
            const used = groups.length > 0 || (tier === 'indexer' && parsingCount > 0);
            return (
              <div key={tier} className="flex flex-col items-stretch gap-2">
                {i > 0 && <Arrow active={used} />}
                <TierBox tier={tier} groups={groups} used={used} parsingCount={parsingCount} />
              </div>
            );
          })}

          {tiers.unknown.length > 0 && (
            <section
              aria-labelledby="architecture-tier-unknown"
              className="mt-2 px-3 py-2 rounded border border-dashed border-[var(--color-border-hover)] bg-[var(--color-bg-secondary)]"
            >
              <h2 id="architecture-tier-unknown" className="text-xs font-semibold text-[var(--color-text-primary)]">
                Tier not known
              </h2>
              <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                Propslab cannot say where these directives run. Each one gives the reason.
              </p>
              {tiers.unknown.map((group, g) => (
                <StanzaList key={`${group.stanza}-${g}`} stanza={group.stanza} directives={group.directives} />
              ))}
            </section>
          )}

          {anyDirective && (
            <p className="mt-2 text-xs text-[var(--color-text-muted)]">
              A transforms.conf stanza runs on the tier of the props.conf directive that names it. Select a directive to
              go to its line in props.conf.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const TIER_TEXT: Record<TierId, { label: string; role: string }> = {
  'universal-forwarder': {
    label: 'Universal forwarder',
    role: 'Reads the data in and sends it on: the input layer.',
  },
  'heavy-forwarder': {
    label: 'Heavy forwarder',
    role: 'Parses the data at index time. This is the first full Splunk instance on the path of the data.',
  },
  indexer: { label: 'Indexer', role: 'Writes the events to the index.' },
  'search-head': { label: 'Search head', role: 'Extracts and calculates fields when a search runs.' },
};

function TierBox({
  tier,
  groups,
  used,
  parsingCount,
}: {
  tier: TierId;
  groups: { stanza: string; directives: PlacedDirective[] }[];
  used: boolean;
  parsingCount: number;
}) {
  const headingId = `architecture-tier-${tier}`;
  const count = countDirectives(groups);
  const { label, role } = TIER_TEXT[tier];
  return (
    <section
      aria-labelledby={headingId}
      data-tier={tier}
      data-used={used}
      className={`px-3 py-2 rounded border ${
        used
          ? 'border-[var(--color-accent)] bg-[var(--color-bg-secondary)] shadow-sm'
          : 'border-[var(--color-border)] bg-[var(--color-bg-tertiary)]'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2
          id={headingId}
          className={`text-xs font-semibold ${used ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'}`}
        >
          {label}
        </h2>
        {/* Said in words as well as by the border, so the state does not depend on colour. */}
        <span className={`text-xs ${used ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`}>
          {used
            ? count > 0
              ? `Used: ${count} directive${count === 1 ? '' : 's'}`
              : 'Used'
            : 'Not used by this config'}
        </span>
      </div>
      <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{role}</p>
      {tier === 'heavy-forwarder' && parsingCount > 0 && (
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
          With no heavy forwarder on the path, the indexer runs these.
        </p>
      )}
      {tier === 'indexer' && parsingCount > 0 && (
        <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
          Runs the {parsingCount} directive{parsingCount === 1 ? '' : 's'} of the heavy forwarder when the data does not
          pass through one.
        </p>
      )}
      {groups.map((group, g) => (
        <StanzaList key={`${group.stanza}-${g}`} stanza={group.stanza} directives={group.directives} />
      ))}
    </section>
  );
}

function StanzaList({ stanza, directives }: { stanza: string; directives: (PlacedDirective & { reason?: string })[] }) {
  return (
    <div className="mt-2">
      <h3 className="text-xs font-mono text-[var(--color-text-secondary)]">[{stanza}]</h3>
      <ul className="mt-0.5">
        {directives.map((d) => (
          <li key={`${d.key}-${d.line}`}>
            <JumpButton directive={d} />
            {d.reason !== undefined && <p className="pl-2 text-xs text-[var(--color-text-muted)]">{d.reason}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The same jump as "Jump to config" in the Effective config tab. */
function JumpButton({ directive }: { directive: PlacedDirective }) {
  return (
    <button
      type="button"
      onClick={() => revealInEditor('props.conf', directive.line)}
      title={`Go to line ${directive.line} of props.conf`}
      className="flex w-full min-w-0 min-h-6 items-center gap-1 px-2 rounded text-left text-xs font-mono cursor-pointer bg-transparent border-none hover:bg-[var(--color-bg-tertiary)] hover:underline"
    >
      {/* The spaces between the spans keep the words apart in the button's accessible name. */}
      <span className="shrink-0 text-[var(--color-text-primary)]">{directive.key}</span>{' '}
      <span className="min-w-0 truncate text-[var(--color-text-secondary)]">= {directive.value}</span>{' '}
      <span className="ml-auto shrink-0 pl-2 text-[var(--color-text-muted)]">line {directive.line}</span>
    </button>
  );
}

function Arrow({ active }: { active: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`flex flex-col items-center ${active ? 'text-[var(--color-accent)]' : 'text-[var(--color-border-hover)]'}`}
    >
      <div className="w-0.5 h-3 bg-current" />
      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
        <path d="M12 16l-6-6h12l-6 6z" />
      </svg>
    </div>
  );
}
