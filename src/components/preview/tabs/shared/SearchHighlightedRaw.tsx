// ---------------------------------------------------------------------------
// SearchHighlightedRaw.tsx
// An event's text with each match of the preview search marked, and the
// lines without one dimmed.
// ---------------------------------------------------------------------------

import type React from 'react';

export function SearchHighlightedRaw({ raw, search }: { raw: string; search: string }) {
  const trimmed = search.trim().toLowerCase();

  if (!trimmed) return <>{raw}</>;

  const lines = raw.split('\n');

  return (
    <>
      {lines.map((line, lineIdx) => {
        const lowerLine = line.toLowerCase();
        const hasMatch = lowerLine.includes(trimmed);

        // Build line content with highlighted matches
        let content: React.ReactNode;
        if (hasMatch) {
          const segments: React.ReactNode[] = [];
          let cursor = 0;
          let searchIdx = lowerLine.indexOf(trimmed, cursor);
          while (searchIdx !== -1) {
            if (searchIdx > cursor) {
              segments.push(line.substring(cursor, searchIdx));
            }
            segments.push(
              <mark
                key={searchIdx}
                className="rounded-sm px-0.5"
                style={{
                  backgroundColor: 'var(--color-accent)',
                  color: 'var(--color-text-on-accent)',
                }}
              >
                {line.substring(searchIdx, searchIdx + trimmed.length)}
              </mark>
            );
            cursor = searchIdx + trimmed.length;
            searchIdx = lowerLine.indexOf(trimmed, cursor);
          }
          if (cursor < line.length) {
            segments.push(line.substring(cursor));
          }
          content = segments;
        } else {
          content = line;
        }

        return (
          <span
            key={lineIdx}
            style={{
              opacity: hasMatch ? 1 : 0.35,
              transition: 'opacity 0.15s',
            }}
          >
            {content}
            {lineIdx < lines.length - 1 ? '\n' : ''}
          </span>
        );
      })}
    </>
  );
}
