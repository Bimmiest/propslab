import { useState, useRef, useEffect, useMemo, useId, type FocusEvent, type KeyboardEvent } from 'react';
import { Icon } from './Icon';

interface MultiSelectProps {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
  searchable?: boolean;
}

export function MultiSelect({ label, options, selected, onChange, searchable }: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popupId = useId();

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      close();
      triggerRef.current?.focus();
    }
  };

  // Tabbing out of an open popup used to leave it open behind the focus,
  // covering whatever the user had moved on to (#300). Only a move to a known
  // element outside closes it: a null relatedTarget is a click on something
  // unfocusable inside the popup (its padding, "No matches"), which the
  // outside-mousedown handler below already covers when it is truly outside.
  const handleBlur = (e: FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (open && next && ref.current && !ref.current.contains(next)) close();
  };

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  useEffect(() => {
    if (open && searchable) {
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, searchable]);

  const filteredOptions = useMemo(() => {
    if (!query) return options;
    const lower = query.toLowerCase();
    return options.filter((o) => o.toLowerCase().includes(lower));
  }, [options, query]);

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  const activeCount = selected.size;
  const showSearch = searchable && options.length > 8;

  return (
    // The wrapper listens for keys and focus bubbling up from its own controls;
    // it is not itself interactive.
    <div ref={ref} className="relative" onKeyDown={handleKeyDown} onBlur={handleBlur}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        // A disclosure, not a listbox: the popup is a group of checkboxes plus a
        // filter field, and `aria-haspopup="listbox"` announced a widget whose
        // option/arrow-key model it does not have (#300). aria-expanded and
        // aria-controls are what the disclosure pattern asks for.
        aria-expanded={open}
        aria-controls={open && options.length > 0 ? popupId : undefined}
        className="flex items-center gap-1 px-2 py-1 text-xs rounded border cursor-pointer"
        style={{
          backgroundColor: activeCount > 0 ? 'var(--color-accent)' : 'var(--color-bg-primary)',
          color: activeCount > 0 ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
          borderColor: activeCount > 0 ? 'var(--color-accent)' : 'var(--color-border)',
        }}
      >
        <span>{label}</span>
        {activeCount > 0 && (
          <span className="bg-white/25 rounded-full px-1 text-[10px] leading-4">{activeCount}</span>
        )}
        <Icon name="chevron-down" className="w-3 h-3" />
      </button>
      {open && options.length > 0 && (
        <div
          id={popupId}
          role="group"
          aria-label={`${label} options`}
          className="absolute top-full left-0 mt-1 z-50 min-w-[180px] max-w-[260px] max-h-[280px] flex flex-col rounded border shadow-lg"
          style={{
            backgroundColor: 'var(--color-bg-secondary)',
            borderColor: 'var(--color-border)',
          }}
        >
          {showSearch && (
            <div className="p-1.5 border-b border-[var(--color-border)] shrink-0">
              <div className="relative">
                <Icon name="search" className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--color-text-muted)] pointer-events-none" />
                <input
                  ref={searchRef}
                  type="text"
                  aria-label={`Filter ${label} options`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter…"
                  className="w-full pl-6 pr-2 py-0.5 text-xs rounded bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                />
              </div>
            </div>
          )}
          <div className="overflow-auto flex-1">
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">No matches</div>
            ) : (
              filteredOptions.map((opt) => (
                <label
                  key={opt}
                  className="flex items-center gap-2 px-2.5 py-1.5 text-xs cursor-pointer hover:bg-[var(--color-bg-tertiary)]"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(opt)}
                    onChange={() => toggle(opt)}
                    className="rounded accent-[var(--color-accent)]"
                  />
                  <span className="truncate">{opt}</span>
                </label>
              ))
            )}
          </div>
          {activeCount > 0 && (
            <button
              type="button"
              onClick={() => {
                onChange(new Set());
                // This button unmounts with the selection it clears; without a
                // new home, focus would fall to <body>.
                triggerRef.current?.focus();
              }}
              className="w-full px-2.5 py-1.5 text-xs text-left border-t cursor-pointer shrink-0 hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] border-[var(--color-border)]"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}
