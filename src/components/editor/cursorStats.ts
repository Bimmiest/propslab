// ---------------------------------------------------------------------------
// cursorStats.ts
// The numbers CursorPosition shows (#740), from the text before the cursor
// and the selected text.
// ---------------------------------------------------------------------------

export interface CursorStats {
  line: number;
  /** 1-based, in characters. */
  col: number;
  /** 1-based, in UTF-8 bytes. */
  byte: number;
  /** The selection's length in characters, 0 when nothing is selected. */
  chars: number;
  /** The selection's length in UTF-8 bytes. */
  bytes: number;
}

const utf8 = new TextEncoder();

/** Characters, not UTF-16 code units: Monaco's own column counts a character outside the BMP as two. */
const charCount = (s: string) => s.length - (s.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0);

export function cursorStats(line: number, beforeCursor: string, selected: string): CursorStats {
  return {
    line,
    col: charCount(beforeCursor) + 1,
    byte: utf8.encode(beforeCursor).length + 1,
    chars: charCount(selected),
    bytes: utf8.encode(selected).length,
  };
}

/** What the footer shows. `withBytes` for the raw log, where TRUNCATE counts bytes. */
export function formatCursorStats(s: CursorStats, withBytes: boolean): string {
  let text = `Ln ${s.line}, Col ${s.col}`;
  if (withBytes) text += `, Byte ${s.byte}`;
  if (s.chars > 0) text += ` · ${s.chars} selected` + (withBytes ? ` (${s.bytes} bytes)` : '');
  return text;
}
