import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import { useAppStore } from '../../store/useAppStore';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { Icon } from '../ui/Icon';
import { DictionaryFilterBar, DictionaryList } from './DictionaryList';
import { DictionaryDetail } from './DictionaryDetail';
import {
  buildEntries,
  filterEntries,
  findEntry,
  DEFAULT_FILTERS,
  type DictionaryFilters,
} from './entries';

// Built once at module scope: the registry is static, so rebuilding the entry
// list per render (or per keystroke in the search box) would be pure waste.
const ALL_ENTRIES = buildEntries();

/**
 * The phone layout's list/detail hand-off (#494).
 *
 * On a phone the store's selection means "drilled into the detail", so the
 * arrow keys cannot write to it: the first ArrowDown would swap the list for
 * the detail pane and unmount the focused listbox. The list keeps its own
 * cursor there instead; Enter or a click commits it to the store. Drilling in
 * or out unmounts the control that had focus, so focus goes to its counterpart
 * on the other side rather than to <body>.
 */
function usePhoneDrill(isMobile: boolean, selectedEntryId: string | null, storeSelection: string | null) {
  const setDictionarySelection = useAppStore((s) => s.setDictionarySelection);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const drilled = isMobile && Boolean(storeSelection) && selectedEntryId !== null;
  const listActiveId = isMobile ? (cursorId ?? selectedEntryId) : selectedEntryId;

  const pendingFocus = useRef<'list' | 'back' | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === 'back') backRef.current?.focus();
    else if (target === 'list') {
      const listbox = listRef.current?.querySelector<HTMLElement>('[role="listbox"]');
      listbox?.focus();
      listbox?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }
  }, [drilled]);

  const select = (id: string) => {
    if (isMobile) {
      pendingFocus.current = 'back';
      setCursorId(id);
    }
    setDictionarySelection(id);
  };

  const back = () => {
    pendingFocus.current = 'list';
    setCursorId(selectedEntryId);
    setDictionarySelection(null);
  };

  return { drilled, listActiveId, select, back, onMove: isMobile ? setCursorId : undefined, listRef, backRef };
}

/**
 * Reference view for every props.conf and transforms.conf setting the simulator
 * knows about, plus the four stanza header kinds.
 *
 * All of the content comes from the same registries that drive autocomplete,
 * hover and linting — this view adds browsing and filtering, not new prose, so
 * the editor and the dictionary can never drift apart.
 */
export function DictionaryView() {
  const selectedId = useAppStore((s) => s.dictionarySelection);
  const isMobile = useMediaQuery('(max-width: 767px)');

  const [filters, setFilters] = useState<DictionaryFilters>(DEFAULT_FILTERS);

  const visible = useMemo(() => filterEntries(ALL_ENTRIES, filters), [filters]);

  // Fall back to the first visible entry so the detail pane is never blank, but
  // do NOT write that back to the store: an implicit fallback that persists
  // would be indistinguishable from a deliberate selection the next time the
  // filters change.
  const selected =
    findEntry(visible, selectedId) ?? findEntry(ALL_ENTRIES, selectedId) ?? visible[0] ?? null;

  const { drilled, listActiveId, select, back, onMove, listRef, backRef } = usePhoneDrill(
    isMobile,
    selected?.id ?? null,
    selectedId,
  );

  const list = (
    <div
      ref={listRef}
      className="h-full flex flex-col"
      style={{ backgroundColor: 'var(--color-bg-secondary)' }}
    >
      <DictionaryFilterBar
        filters={filters}
        onChange={setFilters}
        resultCount={visible.length}
        totalCount={ALL_ENTRIES.length}
      />
      <DictionaryList
        entries={visible}
        selectedId={listActiveId}
        onSelect={select}
        onMove={onMove}
      />
    </div>
  );

  const detail = selected ? (
    <div className="h-full overflow-y-auto">
      <DictionaryDetail entry={selected} />
    </div>
  ) : (
    <div className="h-full flex items-center justify-center px-6">
      <p className="text-xs text-center text-[var(--color-text-muted)]">
        Select a directive to see its documentation.
      </p>
    </div>
  );

  // On a phone the two panes cannot sit side by side, so the list and the detail
  // take turns: choosing an entry swaps to the detail, and a back control
  // returns. `selectedId` doubles as "has the user drilled in yet", which is
  // also what makes a deep link from elsewhere open straight onto the detail.
  if (isMobile) {
    if (!drilled || !selected) return list;
    return (
      <div className="h-full flex flex-col">
        <div
          className="shrink-0 flex items-center gap-2 px-3 h-10 border-b"
          style={{
            borderColor: 'var(--color-border-subtle)',
            backgroundColor: 'var(--color-bg-secondary)',
          }}
        >
          <button
            ref={backRef}
            type="button"
            onClick={back}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs cursor-pointer border-none bg-transparent
              text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]
              outline-none focus-visible:ring-2 transition-colors"
          >
            <Icon name="chevron-left" className="w-3.5 h-3.5" />
            All directives
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <DictionaryDetail entry={selected} />
        </div>
      </div>
    );
  }

  return (
    // Mixed units, deliberately: react-resizable-panels v4 reads a number as
    // pixels and a string as a percentage, and the two bounds want different
    // ones. The floor is a PIXEL count because it is about legibility — a row
    // needs about this much to show a key beside its badges, and that does not
    // change with the window. A percentage floor gets it backwards, growing on
    // exactly the wide screens where a narrow list is most reasonable and
    // refusing to shrink for the small ones that need it. The ceiling stays a
    // percentage because it is about proportion, not content.
    <Group orientation="horizontal" id="dictionary-horizontal">
      <Panel defaultSize="26" minSize={168} maxSize="45" id="dictionary-list">
        {list}
      </Panel>
      <Separator
        className="group relative flex items-center justify-center w-1.5 cursor-col-resize
          bg-[var(--color-border)] hover:bg-[var(--color-accent)] transition-colors"
      >
        <div className="w-0.5 h-8 rounded-full bg-[var(--color-text-muted)] group-hover:bg-white transition-colors" />
      </Separator>
      <Panel defaultSize="74" minSize="30" id="dictionary-detail">
        {detail}
      </Panel>
    </Group>
  );
}
