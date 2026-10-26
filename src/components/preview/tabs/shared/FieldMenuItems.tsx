import { copyQuietly } from '../../../../utils/clipboard';
import { useAppStore } from '../../../../store/useAppStore';
import { revealInEditor } from '../../../editor/revealInEditor';
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from '../../../ui/ContextMenu';
import { currentFieldDirectiveLine } from './fieldDirective';

/**
 * A field's context menu, the same wherever a field is shown (#745): the
 * Fields table, the field tree and a highlighted value. Each place passes what
 * it knows; an action whose input is missing is left out rather than guessed.
 *
 * Rendered only while the menu is open, so the props.conf lookup behind "Jump
 * to config" runs once per opening.
 */
export function FieldMenuItems({
  field,
  value,
  values,
  sources,
  pinned,
  onTogglePin,
}: {
  field: string;
  /** The one value in view, for a highlighted value. */
  value?: string;
  /** A sample of the field's values, for a table row. */
  values?: Iterable<string>;
  /** The processors that made the field, when known; otherwise read from the run. */
  sources?: Iterable<string>;
  /** Unknown where the caller cannot tell, which names the action both ways. */
  pinned?: boolean;
  onTogglePin?: (field: string) => void;
}) {
  const setFieldAlias = useAppStore((s) => s.setFieldAlias);
  const line = currentFieldDirectiveLine(field, sources);

  return (
    <>
      <ContextMenuLabel>{field}</ContextMenuLabel>
      <ContextMenuItem onSelect={() => copyQuietly(field)}>Copy field name</ContextMenuItem>
      {value !== undefined && (
        <>
          <ContextMenuItem onSelect={() => copyQuietly(value)}>Copy value</ContextMenuItem>
          <ContextMenuItem onSelect={() => copyQuietly(`${field}=${value}`)}>Copy field=value</ContextMenuItem>
        </>
      )}
      {values !== undefined && (
        <ContextMenuItem onSelect={() => copyQuietly(Array.from(values).join(', '))}>
          Copy sample values
        </ContextMenuItem>
      )}
      {onTogglePin && (
        <ContextMenuItem onSelect={() => onTogglePin(field)}>
          {pinned === undefined ? 'Pin / unpin field' : pinned ? 'Unpin field' : 'Pin field'}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => setFieldAlias({ source: field })}>Create FIELDALIAS…</ContextMenuItem>
      <ContextMenuItem disabled={line === null} onSelect={() => line !== null && revealInEditor('props.conf', line)}>
        Jump to config
      </ContextMenuItem>
    </>
  );
}
