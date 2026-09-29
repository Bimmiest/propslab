import { useMemo } from 'react';
import { useTimestampMatch } from '../../../../hooks/useTimestampMatch';
import { usePipelineInputs, type PipelineInputs } from '../shared/usePipelineInputs';
import type { EnrichedEvent } from '../../PreviewPanel';
import { extractDirectives, parseTimeConfig, resolvedTimeSource, timestampTextOf } from './timestampLogic';
import { ConfigSummary, TimestampLegend } from './ConfigSummary';
import { StrptimeReference } from './StrptimeReference';
import { TimestampEventCard } from './TimestampEventCard';

interface TimestampTabProps {
  items: EnrichedEvent[];
  currentPage: number;
  eventsPerPage: number;
  /**
   * The inputs of the last pipeline run, from PreviewPanel. This tab unmounts
   * whenever another sub-tab is shown, which is when edits happen, so an
   * instance of the hook here would start from unrun edits. The
   * fallback serves a tab rendered on its own.
   */
  inputs?: PipelineInputs;
}

export function TimestampTab({ items, currentPage, eventsPerPage, inputs }: TimestampTabProps) {
  const ownInputs = usePipelineInputs();
  const { propsConf, metadata } = inputs ?? ownInputs;

  const config = useMemo(() => parseTimeConfig(propsConf, metadata), [propsConf, metadata]);

  // Probing runs in a terminatable worker: TIME_PREFIX is a user regex, and
  // executed during render nothing could interrupt it. Memoised so the
  // hook re-probes when the events or the config change, not on every render.
  // The text probed is the text the extractor read, not the final `_raw`: a
  // SEDCMD or an index-time transform runs after timestamping and may have
  // rewritten the very prefix the tab would then fail to find.
  const raws = useMemo(() => items.map((item) => timestampTextOf(item.event)), [items]);
  const { status, probes, error } = useTimestampMatch(raws, config);

  const directives = useMemo(
    () => config.timeFormat ? extractDirectives(config.timeFormat) : [],
    [config.timeFormat]
  );

  return (
    <div className="flex flex-col h-full">
      <ConfigSummary config={config} directives={directives} />
      <StrptimeReference activeDirectives={directives.map((d) => d.directive)} />
      <TimestampLegend />

      {/* Events */}
      {/* Focusable so the list scrolls from the keyboard: the cards hold no
          focusable content of their own (axe scrollable-region-focusable). */}
      <div className="flex-1 overflow-auto p-3 space-y-3" tabIndex={0} role="region" aria-label="Timestamp matches">
        {!config.timeFormat ? (
          <div className="flex items-center justify-center py-12 text-[var(--color-text-muted)] text-sm">
            No TIME_FORMAT configured in props.conf
          </div>
        ) : status === 'timeout' ? (
          // The worker's watchdog stopped the probe: say so, rather than
          // leaving the tab unresponsive.
          <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
            <span className="text-sm font-medium text-[var(--color-error)]">
              Timestamp matching timed out
            </span>
            <span className="text-xs text-[var(--color-text-muted)] max-w-md">
              TIME_PREFIX took too long to match. The usual cause is a regular expression
              that backtracks catastrophically — nested or overlapping quantifiers such as{' '}
              <code className="font-mono">(a|a)*</code>.
            </span>
          </div>
        ) : status === 'error' ? (
          // A throw inside the prober, reported as itself rather than as the
          // timeout above, which would send people looking for a backtracking
          // TIME_PREFIX that is not there.
          <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
            <span className="text-sm font-medium text-[var(--color-error)]">
              Timestamp matching failed
            </span>
            <span className="text-xs text-[var(--color-text-muted)] max-w-md font-mono">{error}</span>
          </div>
        ) : (
          items.map((item, idx) => {
            const globalIdx = (currentPage - 1) * eventsPerPage + idx + 1;
            return (
              <TimestampEventCard
                key={idx}
                raw={raws[idx] ?? item.event._raw}
                rewritten={raws[idx] !== undefined && raws[idx] !== item.event._raw}
                globalIdx={globalIdx}
                config={config}
                probe={probes[idx] ?? null}
                pending={status === 'pending'}
                resolvedTime={item.event._time}
                timeSource={resolvedTimeSource(item.event)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
