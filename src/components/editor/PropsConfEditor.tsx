import { useCallback } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { SplunkEditor } from './LazyEditors';
import { CopyButton } from './CopyButton';
import { ClearButton } from './ClearButton';
import { EditorValidationList } from './EditorValidationList';
import { Icon } from '../ui/Icon';

export function PropsConfEditor() {
  const propsConf = useAppStore((s) => s.propsConf);
  const setPropsConf = useAppStore((s) => s.setPropsConf);
  const collapsed = useAppStore((s) => !!s.collapsedPanels['props.conf']);
  const toggleCollapse = useAppStore((s) => s.togglePanelCollapse);

  const getText = useCallback(() => propsConf, [propsConf]);

  if (collapsed) {
    return (
      <div className="bg-[var(--color-bg-primary)] border-t border-[var(--color-border)]">
        <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--color-bg-secondary)]">
          <button
            type="button"
            onClick={() => toggleCollapse('props.conf')}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            title="Expand props.conf"
          >
            <Icon name="chevron-down" className="w-3.5 h-3.5 text-[var(--color-text-muted)] -rotate-90" />
            <Icon name="settings" className="w-3.5 h-3.5 text-[var(--color-accent)]" />
            <span className="text-xs font-semibold tracking-wide text-[var(--color-text-secondary)]">props.conf</span>
          </button>
        </div>
        <EditorValidationList file="props.conf" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-primary)]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
        <button
          type="button"
          onClick={() => toggleCollapse('props.conf')}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          title="Collapse props.conf"
        >
          <Icon name="chevron-down" className="w-3.5 h-3.5 text-[var(--color-text-muted)] transition-transform" />
          <Icon name="settings" className="w-3.5 h-3.5 text-[var(--color-accent)]" />
          <span className="text-xs font-semibold tracking-wide text-[var(--color-text-secondary)]">props.conf</span>
        </button>
        <div className="flex items-center gap-1">
          <ClearButton onClear={() => setPropsConf('')} label="Clear" />
          <CopyButton getText={getText} />
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <SplunkEditor value={propsConf} onChange={setPropsConf} fileType="props.conf" />
      </div>
      <EditorValidationList file="props.conf" />
    </div>
  );
}
