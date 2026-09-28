import { useEffect, useCallback } from 'react';
import type React from 'react';
import { Command } from 'cmdk';
import { useAppStore } from '../../store/useAppStore';
import { SAMPLE_CONFIGS } from '../../engine/sampleData';
import { getAllDirectives } from '../../engine/directiveRegistry';
import type { OutputTabId } from '../../engine/types';
import { Icon } from './Icon';
import { Overlay } from './Overlay';

// Static registry, so the lookup list is built once rather than per keystroke.
// Deduplicated because a few keys (MATCH_LIMIT, DEPTH_LIMIT) are registered once
// per conf file: one palette entry per key is what a lookup wants, and repeated
// keys would collide as React list keys.
const DIRECTIVE_KEYS = [...new Set(getAllDirectives().map((d) => d.key))];

const OUTPUT_TABS: { id: OutputTabId; label: string }[] = [
  { id: 'preview', label: 'Preview' },
  { id: 'cim', label: 'CIM Models' },
  { id: 'fields', label: 'Fields' },
  { id: 'transforms', label: 'Pipeline' },
  { id: 'effective', label: 'Effective config' },
  { id: 'architecture', label: 'Architecture' },
];

/** Runs a command's action, then closes the palette. */
type RunCommand = (fn: () => void) => void;

/** Replaces all four inputs at once: a sample, or empty ones. */
function useLoadInputs() {
  const setRawData = useAppStore((s) => s.setRawData);
  const setPropsConf = useAppStore((s) => s.setPropsConf);
  const setTransformsConf = useAppStore((s) => s.setTransformsConf);
  const setMetadata = useAppStore((s) => s.setMetadata);
  return (inputs: Pick<(typeof SAMPLE_CONFIGS)[number], 'rawData' | 'propsConf' | 'transformsConf' | 'metadata'>) => {
    setRawData(inputs.rawData);
    setPropsConf(inputs.propsConf);
    setTransformsConf(inputs.transformsConf);
    setMetadata(inputs.metadata);
  };
}

export function CommandPalette() {
  const open = useAppStore((s) => s.commandPaletteOpen);
  const toggleCommandPalette = useAppStore((s) => s.toggleCommandPalette);

  const close = useCallback(() => {
    if (open) toggleCommandPalette();
  }, [open, toggleCommandPalette]);

  // Escape (topmost layer only), the focus trap that `aria-modal` promises, and
  // focus restore on close all come from the shared overlay hook.

  // Global Ctrl+K / Cmd+K shortcut. Capture phase, and the event stops here:
  // Monaco takes Ctrl+K as a chord prefix on its own element, so a bubbling
  // listener never saw the key while an editor had focus.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Compare case-insensitively: with Caps Lock on, `e.key` is "K", and the
      // shortcut did nothing at all.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        toggleCommandPalette();
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [toggleCommandPalette]);

  const run = useCallback<RunCommand>(
    (fn) => {
      fn();
      close();
    },
    [close],
  );

  if (!open) return null;

  return (
    <Overlay
      open
      onClose={close}
      label="Command palette"
      className="w-full max-w-lg rounded-xl overflow-hidden shadow-2xl"
      style={{
        backgroundColor: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
      }}
    >
      <Command label="Command palette">
        <PaletteInput />

        <Command.List
          className="max-h-80 overflow-y-auto py-1"
        >
          <Command.Empty
            className="py-6 text-center text-sm"
            style={{ color: 'var(--color-text-muted)' }}
          >
            No results found.
          </Command.Empty>

          <ExampleCommands run={run} />
          <NavigateCommands run={run} />
          <LookupCommands run={run} />
          <ActionCommands run={run} />
        </Command.List>
      </Command>
    </Overlay>
  );
}

function PaletteInput() {
  return (
    <div
      className="flex items-center gap-2 px-3 border-b"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <Icon name="search" className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" />
      <Command.Input
        placeholder="Type a command…"
        className="flex-1 h-11 bg-transparent text-sm outline-none placeholder:text-[var(--color-text-muted)]"
        style={{ color: 'var(--color-text-primary)' }}
        autoFocus
      />
      <kbd
        className="px-1.5 py-0.5 text-[10px] rounded font-mono"
        style={{
          backgroundColor: 'var(--color-bg-tertiary)',
          color: 'var(--color-text-muted)',
        }}
      >
        ESC
      </kbd>
    </div>
  );
}

function ExampleCommands({ run }: { run: RunCommand }) {
  const loadInputs = useLoadInputs();
  return (
    <CommandGroup heading="Examples">
      {SAMPLE_CONFIGS.map((sample) => (
        <CommandItem
          key={sample.name}
          label={`Load: ${sample.name}`}
          hint={sample.description}
          icon="terminal"
          onSelect={() => run(() => loadInputs(sample))}
        />
      ))}
    </CommandGroup>
  );
}

function NavigateCommands({ run }: { run: RunCommand }) {
  const setActiveOutputTab = useAppStore((s) => s.setActiveOutputTab);
  const setActiveView = useAppStore((s) => s.setActiveView);
  return (
    <CommandGroup heading="Navigate">
      <CommandItem
        label="Go to: Simulator"
        icon="sliders"
        onSelect={() => run(() => setActiveView('simulator'))}
      />
      <CommandItem
        label="Go to: Dictionary"
        hint="Browse every directive"
        icon="book"
        onSelect={() => run(() => setActiveView('dictionary'))}
      />
      {OUTPUT_TABS.map((tab) => (
        <CommandItem
          key={tab.id}
          label={`Go to: ${tab.label}`}
          icon="arrow-right"
          // The output tabs live in the simulator, so switch back to it —
          // otherwise this silently changes a tab the user cannot see.
          onSelect={() =>
            run(() => {
              setActiveView('simulator');
              setActiveOutputTab(tab.id);
            })
          }
        />
      ))}
    </CommandGroup>
  );
}

function LookupCommands({ run }: { run: RunCommand }) {
  const openDictionaryAt = useAppStore((s) => s.openDictionaryAt);
  return (
    <CommandGroup heading="Look up">
      {DIRECTIVE_KEYS.map((key) => (
        <CommandItem
          key={key}
          label={`Dictionary: ${key}`}
          icon="book"
          onSelect={() => run(() => openDictionaryAt(key))}
        />
      ))}
    </CommandGroup>
  );
}

function ActionCommands({ run }: { run: RunCommand }) {
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const toggleHelp = useAppStore((s) => s.toggleHelp);
  const toggleScaffold = useAppStore((s) => s.toggleScaffold);
  const loadInputs = useLoadInputs();
  return (
    <CommandGroup heading="Actions">
      <CommandItem
        label="Scaffold config from sample data"
        hint="Suggest props.conf"
        icon="sparkles"
        onSelect={() => run(toggleScaffold)}
      />
      <CommandItem
        label="Toggle theme"
        icon="sun"
        onSelect={() => run(toggleTheme)}
      />
      <CommandItem
        label="Open pipeline reference"
        icon="info"
        onSelect={() => run(toggleHelp)}
      />
      <CommandItem
        label="Clear all editors"
        icon="x"
        onSelect={() =>
          run(() =>
            loadInputs({
              rawData: '',
              propsConf: '',
              transformsConf: '',
              metadata: { index: 'main', host: '', source: '', sourcetype: '' },
            }),
          )
        }
      />
    </CommandGroup>
  );
}

function CommandGroup({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <Command.Group
      heading={heading}
      className="[&>[cmdk-group-heading]]:px-3 [&>[cmdk-group-heading]]:py-1.5 [&>[cmdk-group-heading]]:text-[10px] [&>[cmdk-group-heading]]:font-semibold [&>[cmdk-group-heading]]:uppercase [&>[cmdk-group-heading]]:tracking-wider"
      style={
        { '--heading-color': 'var(--color-text-muted)' } as React.CSSProperties
      }
    >
      {children}
    </Command.Group>
  );
}

function CommandItem({
  label,
  hint,
  icon,
  onSelect,
}: {
  label: string;
  hint?: string;
  icon: React.ComponentProps<typeof Icon>['name'];
  onSelect: () => void;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      // Colours are classes, not inline styles: an inline colour outranked the
      // aria-selected one, leaving dark-on-accent text on the highlighted row.
      className="group flex items-center gap-3 px-3 py-2 mx-1 rounded-lg text-sm cursor-pointer outline-none
        text-[var(--color-text-primary)]
        aria-selected:bg-[var(--color-accent)] aria-selected:text-[var(--color-text-on-accent)]"
    >
      <Icon name={icon} className="w-4 h-4 shrink-0 text-[var(--color-text-muted)] group-aria-selected:text-[var(--color-text-on-accent)]" />
      <span className="flex-1">{label}</span>
      {hint && (
        <span className="text-[11px] truncate max-w-[180px] text-[var(--color-text-muted)] group-aria-selected:text-[var(--color-text-on-accent)]">
          {hint}
        </span>
      )}
    </Command.Item>
  );
}
