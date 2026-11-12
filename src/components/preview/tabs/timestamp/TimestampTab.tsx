import { useMemo } from 'react';
import type { TimeConfig, TimestampProbe } from 'propslab-engine';
import { useTimestampMatch, type TimestampMatchStatus } from '../../../../hooks/useTimestampMatch';
import { useAppStore } from '../../../../store/useAppStore';
import { usePipelineInputs } from '../shared/usePipelineInputs';
import type { EnrichedEvent } from '../../enrichEvents';
import { pageStart } from '../../../../utils/pagination';
import {
  extractDirectives,
  fallbackReason,
  overlaySegments,
  parseTimeConfig,
  recognisedRead,
  recognisedSegments,
  resolvedTimeSource,
  shownKinds,
  summariseRecognition,
  timestampStepOf,
  timestampTextOf,
  type OverlaySegment,
} from './timestampLogic';
import { FALLBACK_LABEL } from './data';
import { ConfigSummary, TimestampLegend } from './ConfigSummary';
import { RecognitionSummaryPanel } from './RecognitionSummary';
import { StrptimeReference } from './StrptimeReference';
import { TimestampEventCard, type TimeBadge } from './TimestampEventCard';

interface TimestampTabProps {
  items: EnrichedEvent[];
  currentPage: number;
  eventsPerPage: number;
}

/**
 * The tab, for the config of the run whose events it shows (#879): the editors
 * can hold config that has not run, and this tab mounts afresh on each switch
 * to it, which is when such edits are made.
 */
export function TimestampTab({ items, currentPage, eventsPerPage }: TimestampTabProps) {
  const { propsConf, metadata } = usePipelineInputs();

  const config = useMemo(() => parseTimeConfig(propsConf, metadata), [propsConf, metadata]);

  // Probing runs in a terminatable worker: TIME_PREFIX is a user regex, and
  // executed during render nothing could interrupt it. Memoised so the
  // hook re-probes when the events or the config change, not on every render.
  // The text probed is the text the extractor read, not the final `_raw`: a
  // SEDCMD or an index-time transform runs after timestamping and may have
  // rewritten the very prefix the tab would then fail to find.
  const raws = useMemo(() => items.map((item) => timestampTextOf(item.event)), [items]);
  const { status, probes, error } = useTimestampMatch(raws, config);

  // With no TIME_FORMAT, the tab shows what automatic recognition did (#898),
  // counted over every event of the run, not only this page's.
  const auto = !config.timeFormat;
  const runEvents = useAppStore((s) => s.processingResult?.events);
  const summary = useMemo(
    () => (auto ? summariseRecognition(runEvents ?? items.map((item) => item.event)) : null),
    [auto, runEvents, items],
  );
  const headlineFormat = summary?.formats[0]?.format;

  const directives = useMemo(
    () => (config.timeFormat ? extractDirectives(config.timeFormat) : []),
    [config.timeFormat],
  );
  const activeDirectives = useMemo(
    () => (config.timeFormat ? directives : extractDirectives(headlineFormat ?? '')).map((d) => d.directive),
    [config.timeFormat, directives, headlineFormat],
  );

  const cards = useMemo(
    () => items.map((item, idx) => cardView(item, raws[idx], probes[idx] ?? null, { config, status, headlineFormat })),
    [items, raws, probes, config, status, headlineFormat],
  );
  const kinds = useMemo(() => shownKinds(cards.map((c) => c.segments)), [cards]);

  return (
    <div className="flex flex-col h-full">
      <ConfigSummary config={config} directives={directives} />
      {summary && <RecognitionSummaryPanel summary={summary} config={config} />}
      <StrptimeReference activeDirectives={activeDirectives} />
      <TimestampLegend kinds={kinds} auto={auto} />

      {/* Events */}
      {/* Focusable so the list scrolls from the keyboard: the cards hold no
          focusable content of their own (axe scrollable-region-focusable). */}
      <div className="flex-1 overflow-auto p-3 space-y-3" tabIndex={0} role="region" aria-label="Timestamp matches">
        {status === 'timeout' ? (
          // The worker's watchdog stopped the probe: say so, rather than
          // leaving the tab unresponsive.
          <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
            <span className="text-sm font-medium text-[var(--color-error)]">Timestamp matching timed out</span>
            <span className="text-xs text-[var(--color-text-muted)] max-w-md">
              TIME_PREFIX took too long to match. The usual cause is a regular expression that backtracks
              catastrophically — nested or overlapping quantifiers such as <code className="font-mono">(a|a)*</code>.
            </span>
          </div>
        ) : status === 'error' ? (
          // A throw inside the prober, reported as itself rather than as the
          // timeout above, which would send people looking for a backtracking
          // TIME_PREFIX that is not there.
          <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
            <span className="text-sm font-medium text-[var(--color-error)]">Timestamp matching failed</span>
            <span className="text-xs text-[var(--color-text-muted)] max-w-md font-mono">{error}</span>
          </div>
        ) : (
          cards.map((card, idx) => (
            <TimestampEventCard
              key={idx}
              raw={card.raw}
              rewritten={card.rewritten}
              globalIdx={pageStart(currentPage, eventsPerPage) + idx + 1}
              segments={card.segments}
              badge={card.badge}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface CardView {
  raw: string;
  rewritten: boolean;
  segments: OverlaySegment[] | null;
  badge: TimeBadge;
}

/**
 * What one card shows. With TIME_FORMAT set, the probe's match against it.
 * Without, the span the engine recorded when automatic recognition read the
 * event, and the probe only for the TIME_PREFIX window; an event it did not
 * read is drawn plain, with the reason and where its `_time` came from.
 */
function cardView(
  item: EnrichedEvent,
  probed: string | undefined,
  probe: TimestampProbe | null,
  {
    config,
    status,
    headlineFormat,
  }: { config: TimeConfig; status: TimestampMatchStatus; headlineFormat: string | undefined },
): CardView {
  const { event } = item;
  const raw = probed ?? event._raw;
  const rewritten = probed !== undefined && probed !== event._raw;

  if (config.timeFormat) {
    const source = resolvedTimeSource(event);
    const fallbackLabel = source ? FALLBACK_LABEL[source] : undefined;
    const parsedMs = probe?.match?.parsedTimeMs ?? null;
    // The event still has a _time when it fell back: it did not come from
    // the event text, so it is badged as a fallback rather than a match.
    const badge: TimeBadge =
      status === 'pending'
        ? { kind: 'pending' }
        : fallbackLabel
          ? { kind: 'fallback', label: fallbackLabel, time: event._time }
          : parsedMs !== null
            ? { kind: 'read', time: new Date(parsedMs) }
            : { kind: 'none', label: 'No match' };
    return { raw, rewritten, segments: overlaySegments(raw, probe, config), badge };
  }

  const read = recognisedRead(event);
  if (read && event._time && read.span.end <= raw.length) {
    return {
      raw,
      rewritten,
      segments: recognisedSegments(raw, probe, config, { ...read, timeMs: event._time.getTime() }),
      badge: { kind: 'read', time: event._time, ...(read.format !== headlineFormat ? { format: read.format } : {}) },
    };
  }
  const reason = fallbackReason(timestampStepOf(event));
  return {
    raw,
    rewritten,
    segments: overlaySegments(raw, probe, config),
    badge: reason
      ? { kind: 'fallback', label: reason, time: event._time }
      : { kind: 'none', label: 'No timestamp read' },
  };
}
