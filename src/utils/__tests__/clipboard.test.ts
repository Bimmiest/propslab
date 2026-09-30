// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyToClipboard, copyQuietly } from '../clipboard';

// jsdom does not implement document.execCommand, so assign a stub directly.
function stubExecCommand(result: boolean): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockReturnValue(result);
  (document as unknown as { execCommand: unknown }).execCommand = fn;
  return fn;
}

describe('copyToClipboard — fallback failure (#30.4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  // Force the async Clipboard API to reject so the execCommand fallback runs.
  function forceFallback() {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: () => Promise.reject(new Error('unavailable')) },
    });
  }

  it('rejects when execCommand reports failure (no false "copied")', async () => {
    forceFallback();
    const exec = stubExecCommand(false);
    await expect(copyToClipboard('hi')).rejects.toThrow(/failed/i);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('resolves when execCommand reports success', async () => {
    forceFallback();
    stubExecCommand(true);
    await expect(copyToClipboard('hi')).resolves.toBeUndefined();
  });

  it('restores focus to the previously focused element', async () => {
    forceFallback();
    stubExecCommand(true);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    await copyToClipboard('hi');

    expect(document.activeElement).toBe(input);
    document.body.removeChild(input);
  });

  it('restores the previous selection range', async () => {
    forceFallback();
    stubExecCommand(true);

    const span = document.createElement('span');
    span.textContent = 'test text';
    document.body.appendChild(span);

    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = document.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }

    await copyToClipboard('hi');

    const currentSelection = document.getSelection();
    expect(currentSelection?.rangeCount).toBe(1);
    document.body.removeChild(span);
  });
});

describe('copyQuietly', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  // The runner's process, reached through a local type: this file is compiled
  // under tsconfig.app.json, whose `types` is browser-only and deliberately
  // excludes @types/node.
  const runner = (
    globalThis as unknown as {
      process: {
        on(event: 'unhandledRejection', listener: () => void): void;
        off(event: 'unhandledRejection', listener: () => void): void;
      };
    }
  ).process;

  // Context-menu items have nowhere to report a failed copy, but the rejection
  // still has to be settled — left floating it reaches the console as an
  // unhandled rejection.
  it('settles the rejection a failed copy produces', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: () => Promise.reject(new Error('unavailable')) },
    });
    const exec = stubExecCommand(false);
    const unhandled = vi.fn();
    runner.on('unhandledRejection', unhandled);
    try {
      expect(() => copyQuietly('hi')).not.toThrow();
      // Let the promise chain settle before checking for a stray rejection.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(exec).toHaveBeenCalledWith('copy');
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      runner.off('unhandledRejection', unhandled);
    }
  });

  it('copies through on the happy path', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    copyQuietly('hi');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeText).toHaveBeenCalledWith('hi');
  });
});
