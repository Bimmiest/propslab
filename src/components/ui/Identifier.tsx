import type { ReactNode } from 'react';

/**
 * A field, stanza, sourcetype or directive name, shown as the user wrote it.
 * These names are case-sensitive in Splunk (`SRC_IP` is not `src_ip`), so a
 * heading that sets `uppercase` must not change them: `normal-case` and
 * `tracking-normal` undo what the heading passes down to its children. Use this
 * for a name inside a heading, label or menu label; `identifierGuard.test.tsx`
 * fails on a bare `<code>` in an `uppercase` element (#897).
 */
export function Identifier({ children }: { children: ReactNode }) {
  return <code className="font-mono normal-case tracking-normal">{children}</code>;
}
