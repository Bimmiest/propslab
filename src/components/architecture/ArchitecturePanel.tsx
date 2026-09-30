import { useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { parseConf } from '../../engine/parser/confParser';

type ComponentType = 'uf' | 'hf' | 'indexer' | 'searchHead';

interface ComponentState {
  active: boolean;
  configs: string[];
}

const INDEX_TIME_DIRECTIVES = new Set([
  'LINE_BREAKER', 'SHOULD_LINEMERGE', 'BREAK_ONLY_BEFORE', 'BREAK_ONLY_BEFORE_DATE',
  'MUST_BREAK_AFTER', 'TIME_PREFIX', 'TIME_FORMAT', 'MAX_TIMESTAMP_LOOKAHEAD',
  'TRUNCATE', 'SEDCMD', 'TRANSFORMS', 'INDEXED_EXTRACTIONS',
  'EVENT_BREAKER', 'EVENT_BREAKER_ENABLE',
]);

const SEARCH_TIME_DIRECTIVES = new Set([
  'EXTRACT', 'REPORT', 'FIELDALIAS', 'EVAL', 'KV_MODE',
]);

const ROUTING_DIRECTIVES = new Set([
  'TRANSFORMS',
]);

export function ArchitecturePanel({ embedded }: { embedded?: boolean } = {}) {
  const propsConf = useAppStore((s) => s.propsConf);
  const transformsConf = useAppStore((s) => s.transformsConf);

  const components = useMemo(() => {
    const state: Record<ComponentType, ComponentState> = {
      uf: { active: false, configs: [] },
      hf: { active: false, configs: [] },
      indexer: { active: false, configs: [] },
      searchHead: { active: false, configs: [] },
    };

    const parsed = parseConf(propsConf, 'props.conf');
    const parsedTransforms = parseConf(transformsConf, 'transforms.conf');

    let hasIndexTime = false;
    let hasSearchTime = false;
    let hasRouting = false;

    for (const stanza of parsed.stanzas) {
      for (const dir of stanza.directives) {
        if (INDEX_TIME_DIRECTIVES.has(dir.directiveType)) {
          hasIndexTime = true;
          state.hf.configs.push(dir.key);
        }
        if (SEARCH_TIME_DIRECTIVES.has(dir.directiveType)) {
          hasSearchTime = true;
          state.searchHead.configs.push(dir.key);
        }
        if (ROUTING_DIRECTIVES.has(dir.directiveType)) {
          hasRouting = true;
        }
      }
    }

    // Check transforms.conf for routing (DEST_KEY = queue)
    for (const stanza of parsedTransforms.stanzas) {
      const destKey = stanza.directives.find((d) => d.key === 'DEST_KEY');
      if (destKey?.value.trim() === 'queue' || destKey?.value.includes('MetaData:')) {
        hasRouting = true;
        state.hf.configs.push(`${stanza.name}: ${destKey.key}=${destKey.value}`);
      }
    }

    state.uf.active = hasIndexTime || hasRouting;
    state.hf.active = hasIndexTime || hasRouting;
    state.indexer.active = hasIndexTime;
    state.searchHead.active = hasSearchTime;

    return { state, hasIndexTime, hasSearchTime, hasRouting };
  }, [propsConf, transformsConf]);

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-primary)]">
      {!embedded && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <svg className="w-4 h-4 text-[var(--color-accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
          <span className="text-sm font-medium text-[var(--color-text-primary)]">Architecture</span>
        </div>
      )}
      <div className="flex-1 overflow-auto p-3">
        <div className="flex flex-col items-center gap-2">
          <ComponentBox
            label="Universal Forwarder"
            sublabel="inputs.conf"
            active={components.state.uf.active}
            description="Data collection & forwarding"
          />
          <Arrow active={components.state.uf.active} />
          <ComponentBox
            label="Heavy Forwarder"
            sublabel="props.conf + transforms.conf"
            active={components.state.hf.active}
            description={components.hasRouting ? 'Parsing, routing & transformation' : 'Parsing & transformation'}
            highlight={components.hasIndexTime}
          />
          <Arrow active={components.state.indexer.active} />
          <ComponentBox
            label="Indexer"
            sublabel="props.conf + transforms.conf"
            active={components.state.indexer.active}
            description="Index-time processing & storage"
            highlight={components.hasIndexTime}
          />
          <Arrow active={components.state.searchHead.active} />
          <ComponentBox
            label="Search Head"
            sublabel="props.conf"
            active={components.state.searchHead.active}
            description="Search-time field extraction"
            highlight={components.hasSearchTime}
          />
        </div>

        {!components.hasIndexTime && !components.hasSearchTime && (
          <div className="mt-4 text-center text-xs text-[var(--color-text-muted)]">
            Add props.conf / transforms.conf configuration to see deployment recommendations
          </div>
        )}
      </div>
    </div>
  );
}

function ComponentBox({
  label,
  sublabel,
  active,
  description,
  highlight,
}: {
  label: string;
  sublabel: string;
  active: boolean;
  description: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`
        w-full max-w-48 px-3 py-2 rounded border text-center transition-all
        ${active
          ? highlight
            ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 shadow-sm'
            : 'border-[var(--color-border-hover)] bg-[var(--color-bg-secondary)]'
          : 'border-[var(--color-border)] bg-[var(--color-bg-tertiary)]'
        }
      `}
    >
      {/* An inactive box is dimmed with the muted token, not opacity. */}
      <div className={`text-xs font-semibold ${active ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'}`}>{label}</div>
      <div className="text-xs text-[var(--color-text-muted)] font-mono">{sublabel}</div>
      {active && <div className="text-xs text-[var(--color-text-secondary)] mt-1">{description}</div>}
    </div>
  );
}

function Arrow({ active }: { active: boolean }) {
  return (
    <div className={`flex flex-col items-center ${active ? 'text-[var(--color-accent)]' : 'text-[var(--color-border-hover)]'}`}>
      <div className="w-0.5 h-3 bg-current" />
      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
        <path d="M12 16l-6-6h12l-6 6z" />
      </svg>
    </div>
  );
}
