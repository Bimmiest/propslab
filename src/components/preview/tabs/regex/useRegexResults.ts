import { useEffect, useMemo, useState } from 'react';
import { useRegexMatch } from '../../../../hooks/useRegexMatch';
import type { RegexMatchInfo } from '../../../../engine/regexMatch';
import type { EnrichedEvent } from '../../enrichEvents';
import { NO_RESULTS, alignResults, countMatched } from './regexLogic';

export interface RegexTabProps {
  /** The current page's events — what gets rendered. */
  items: EnrichedEvent[];
  /** The whole filtered dataset — what the match statistics are computed over. */
  allEvents: EnrichedEvent[];
  currentPage: number;
  eventsPerPage: number;
}

/** One event on the rendered page, with its index in the filtered dataset and its match (if known yet). */
export interface PageEntry {
  raw: string;
  datasetIdx: number;
  info: RegexMatchInfo | null | undefined;
}

/**
 * Live matching of `pattern` over the whole filtered dataset, and what the tab
 * can say about it.
 *
 * Run in a terminatable Web Worker. PCRE's limits bound each match, but not
 * the total over thousands of events, so the watchdog still kills a run that
 * takes too long and reports a timeout instead. A pattern with a known
 * validation error is not sent (the tab already shows that error).
 * Matched over the WHOLE filtered dataset, not just the visible page. The
 * header reads "{matched}/{total} events matched" with no scope qualifier, so
 * page-scoped counts said "8/10" while 500 events were loaded — a pattern that
 * failed only on page-2 data read as fully working, which is exactly the false
 * confidence a regex tester exists to prevent. Matching runs in a terminatable
 * worker, so the whole-dataset cost is bounded.
 */
export function useRegexResults(
  pattern: string,
  validationError: string | null,
  { items, allEvents, currentPage, eventsPerPage }: RegexTabProps,
) {
  const rawInputs = useMemo(() => allEvents.map((item) => item.event._raw), [allEvents]);
  const requestedPattern = validationError ? '' : pattern;
  const match = useRegexMatch(requestedPattern, rawInputs);
  // Matching runs on a debounced copy of the pattern, so for 250 ms after each
  // keystroke the results still describe the previous one. Reported as 'ok',
  // they put the old pattern's counts, cards and highlights next to an "Add to
  // props.conf" button that writes the new one — a pattern that matched nothing
  // could be committed under the previous pattern's "3/3 events matched".
  // Until the results catch up with what is typed, they are pending.
  //
  // The results are also tied to the inputs they were matched over. When
  // `allEvents` changes — a pipeline re-run, a search keystroke — the new
  // request is posted from an effect, so the results in hand still index the
  // previous array; indexing them by position into the new events would put
  // one event's match on another's card and the old total beside the new one.
  // They are kept on screen while the re-run is in flight rather than flashing
  // the list to pending, and aligned to the new events by text (below).
  const settled = match.settled !== null && match.settled.pattern === requestedPattern ? match.settled : null;
  const status = settled ? 'ok' : match.pattern === requestedPattern ? match.status : 'pending';
  // Settled results for the typed pattern standing in while newer inputs are matched.
  const refreshing = settled !== null && (match.status === 'pending' || settled.inputs !== rawInputs);

  // The settled results, aligned to the events on screen. A search change
  // resets the shared pagination at once, so the cards follow the new events
  // rather than the previous inputs' page slice: the cards, their numbers and
  // the pagination all describe the same events, and a search refinement,
  // whose events are a subset, is answered in full before the worker replies.
  const aligned = useMemo(() => alignResults(settled, rawInputs), [settled, rawInputs]);

  // The rendered page starts at this offset into `rawInputs`.
  const pageOffset = (currentPage - 1) * eventsPerPage;
  const pageEntries = useMemo<PageEntry[]>(() => {
    if (!pattern || validationError || !settled) return [];
    return items.map((item, i) => ({
      raw: item.event._raw,
      datasetIdx: pageOffset + i,
      info: aligned[pageOffset + i],
    }));
  }, [pattern, validationError, settled, items, pageOffset, aligned]);

  // Exact over the events on screen when every one of them has an answer;
  // otherwise the settled run's own count, marked as updating.
  const countExact = settled !== null && aligned.length === rawInputs.length && !aligned.includes(undefined);
  const matchStats = useMemo(() => {
    if (countExact) return { matched: countMatched(aligned), total: rawInputs.length };
    const matched = countMatched(settled?.results ?? NO_RESULTS);
    return { matched, total: settled ? settled.inputs.length : allEvents.length };
  }, [countExact, aligned, rawInputs, settled, allEvents]);

  return { match, requestedPattern, rawInputs, status, refreshing, pageEntries, countExact, matchStats };
}

/**
 * A confirmation flag that resets itself 1.5 s after it is raised. The reset
 * runs from an effect rather than a bare setTimeout in the click handler, so
 * the timer is cleared if the tab unmounts first (a sub-tab switch within
 * 1.5 s of a click).
 */
export function useFlashFlag(): [boolean, () => void] {
  const [flag, setFlag] = useState(false);
  useEffect(() => {
    if (!flag) return;
    const t = setTimeout(() => setFlag(false), 1500);
    return () => clearTimeout(t);
  }, [flag]);
  return [flag, () => setFlag(true)];
}
