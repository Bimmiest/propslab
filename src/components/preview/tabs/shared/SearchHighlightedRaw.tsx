// ---------------------------------------------------------------------------
// SearchHighlightedRaw.tsx
// An event's text with each match of the preview search marked, and the
// lines without one dimmed.
// ---------------------------------------------------------------------------

import type React from 'react';
import { escapeRegex } from '../../../../utils/splunkRegex';

export function SearchHighlightedRaw({ raw, search }: { raw: string; search: string }) {
  const trimmed = search.trim();

  if (!trimmed) return <>{raw}</>;

  // Matched on each line itself, case-insensitively. Offsets found in
  // `line.toLowerCase()` and cut from `line` drift after a character whose
  // lower case is a different length, such as `İ` (#624).
  const pattern = new RegExp(escapeRegex(trimmed), 'giu');
  const lines = raw.split('\n');

  return (
    <>
      {lines.map((line, lineIdx) => {
        const matches = [...line.matchAll(pattern)];
        const hasMatch = matches.length > 0;

        // Build line content with highlighted matches
        let content: React.ReactNode;
        if (hasMatch) {
          const segments: React.ReactNode[] = [];
          let cursor = 0;
          for (const match of matches) {
            if (match.index > cursor) {
              segments.push(line.substring(cursor, match.index));
            }
            segments.push(
              <mark
                key={match.index}
                className="rounded-sm px-0.5"
                style={{
                  backgroundColor: 'var(--color-accent)',
                  color: 'var(--color-text-on-accent)',
                }}
              >
                {match[0]}
              </mark>,
            );
            cursor = match.index + match[0].length;
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
