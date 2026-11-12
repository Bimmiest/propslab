import { useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { aggregateFields, buildAliasMap, countFieldKinds, fieldCountLabel } from '../preview/tabs/fields/fieldRows';

/**
 * What the field count in the status bar counts, and how it divides. The
 * tooltip's content, so it is mounted, and walks the events, only while the
 * tooltip is open: the bar itself is always mounted, and counts from the
 * run's field statistics alone.
 */
export function FieldCountTip({ fieldCount }: { fieldCount: number }) {
  const result = useAppStore((s) => s.processingResult);
  const kinds = useMemo(() => {
    const events = result?.events ?? [];
    return countFieldKinds(aggregateFields(events, buildAliasMap(events), result?.fieldStats));
  }, [result]);
  // The Fields tab shows an alias in the Aliases column of its source field, not as a row.
  const aliases = Math.max(0, fieldCount - kinds.total);

  return (
    <div className="max-w-[280px] space-y-1 select-text">
      <p>
        {fieldCount} field names in the events after the pipeline: the extracted fields, the aliases, and the default
        fields host, source, sourcetype and index.
      </p>
      <p>
        The Fields tab lists {fieldCountLabel(kinds.total, kinds)}.
        {aliases > 0 ? ` The other ${aliases} ${aliases === 1 ? 'is an alias' : 'are aliases'}.` : ''}
      </p>
    </div>
  );
}
