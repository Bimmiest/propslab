import { describe, expect, it, vi } from 'vitest';
import { exitWhenParentGone, launcherEnv, parentAlive, SHIM_PID_VAR } from '../launcherEnv';

// What the launcher passes to the server it re-execs, and how that server
// notices the launcher is gone (#568).
describe('launcherEnv', () => {
  it('keeps only what node reads, and adds the launcher pid', () => {
    const env = {
      PATH: '/usr/bin',
      NODE_OPTIONS: '--enable-source-maps',
      TZ: 'UTC',
      LANG: 'de_DE.UTF-8',
      LC_ALL: 'C',
      OPENAI_API_KEY: 'sk-secret',
      GITHUB_TOKEN: 'ghp-secret',
      HOME: '/home/me',
    };
    expect(launcherEnv(env, 42)).toEqual({
      PATH: '/usr/bin',
      NODE_OPTIONS: '--enable-source-maps',
      TZ: 'UTC',
      LANG: 'de_DE.UTF-8',
      LC_ALL: 'C',
      [SHIM_PID_VAR]: '42',
    });
  });

  it('matches names without case, as Windows spells them', () => {
    expect(launcherEnv({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows' }, 1)).toEqual({
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      [SHIM_PID_VAR]: '1',
    });
  });
});

describe('parentAlive', () => {
  it('is false once the process was re-parented, as POSIX does to an orphan', () => {
    expect(parentAlive(42, 1, () => true)).toBe(false);
  });

  it('is false when the parent pid no longer answers, as on Windows', () => {
    const gone = () => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    };
    expect(parentAlive(42, 42, gone)).toBe(false);
  });

  it('is true while the parent is there', () => {
    expect(parentAlive(42, 42, () => true)).toBe(true);
    expect(parentAlive(process.ppid)).toBe(true);
  });
});

describe('exitWhenParentGone', () => {
  it('exits once, on the first check that finds the parent gone', () => {
    vi.useFakeTimers();
    try {
      let alive = true;
      const exit = vi.fn();
      exitWhenParentGone(42, () => alive, exit, 1000);
      vi.advanceTimersByTime(3000);
      expect(exit).not.toHaveBeenCalled();
      alive = false;
      vi.advanceTimersByTime(3000);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
