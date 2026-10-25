import { expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

/**
 * Press and click outside every Radix layer, as a mouse does, until Radix
 * reports the press, and return the event it reported. Radix dismisses the
 * layer unless that event is default-prevented.
 *
 * Radix arms its outside-press listener on a later tick and ignores a press
 * made before then, so a test that pressed once after a fixed sleep could
 * assert "not dismissed" without anything having listened. Waiting for the
 * report proves the listener heard the press.
 */
export async function pressOutside(): Promise<Event> {
  const reported: Event[] = [];
  const record = (e: Event) => reported.push(e);
  // The custom event Radix's DismissableLayer dispatches on the press's target.
  document.body.addEventListener('dismissableLayer.pointerDownOutside', record);
  try {
    await vi.waitFor(() => {
      fireEvent.pointerDown(document.body, { pointerType: 'mouse', button: 0 });
      fireEvent.click(document.body);
      expect(reported).toHaveLength(1);
    });
  } finally {
    document.body.removeEventListener('dismissableLayer.pointerDownOutside', record);
  }
  return reported[0]!;
}
