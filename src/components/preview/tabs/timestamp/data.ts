import type { TimeSource } from '../../../../engine/types';

// Theme-aware highlight colours (no hard-coded hex — see design system in CLAUDE.md).
export const PREFIX_COLOR = 'var(--color-info)';
export const FORMAT_COLOR = 'var(--color-success)';
export const LOOKAHEAD_COLOR = 'var(--color-error)';

/**
 * Full strptime reference dictionary grouped by category, and the one place a
 * specifier is described: the format breakdown reads its descriptions from
 * here too. Every specifier strftime.ts implements has a row (a test holds
 * that); rows for specifiers it does not implement are reference only.
 */
export interface StrptimeDirective {
  directive: string;
  description: string;
  example: string;
}

export interface StrptimeCategory {
  name: string;
  directives: StrptimeDirective[];
}

export const STRPTIME_REFERENCE: StrptimeCategory[] = [
  {
    name: 'Year',
    directives: [
      { directive: '%Y', description: '4-digit year', example: '2024' },
      { directive: '%y', description: '2-digit year (00–99)', example: '24' },
      { directive: '%C', description: 'Century (year / 100)', example: '20' },
      { directive: '%G', description: 'ISO 8601 week-based year', example: '2024' },
      { directive: '%g', description: 'ISO 8601 2-digit week-based year', example: '24' },
    ],
  },
  {
    name: 'Month',
    directives: [
      { directive: '%m', description: 'Month as zero-padded number', example: '01–12' },
      { directive: '%b', description: 'Abbreviated month name', example: 'Jan, Feb' },
      { directive: '%B', description: 'Full month name', example: 'January' },
      { directive: '%h', description: 'Same as %b', example: 'Jan' },
    ],
  },
  {
    name: 'Day',
    directives: [
      { directive: '%d', description: 'Day of month, zero-padded', example: '01–31' },
      { directive: '%e', description: 'Day of month, space-padded', example: ' 1–31' },
      { directive: '%j', description: 'Day of year', example: '001–366' },
      { directive: '%u', description: 'ISO weekday (1=Mon, 7=Sun)', example: '1–7' },
      { directive: '%w', description: 'Weekday (0=Sun, 6=Sat)', example: '0–6' },
      { directive: '%a', description: 'Abbreviated weekday name', example: 'Mon, Tue' },
      { directive: '%A', description: 'Full weekday name', example: 'Monday' },
    ],
  },
  {
    name: 'Hour',
    directives: [
      { directive: '%H', description: '24-hour, zero-padded', example: '00–23' },
      { directive: '%I', description: '12-hour, zero-padded', example: '01–12' },
      { directive: '%k', description: '24-hour, space-padded', example: ' 0–23' },
      { directive: '%l', description: '12-hour, space-padded', example: ' 1–12' },
      { directive: '%p', description: 'AM or PM', example: 'AM, PM' },
      { directive: '%P', description: 'am or pm (lowercase)', example: 'am, pm' },
    ],
  },
  {
    name: 'Minute / Second',
    directives: [
      { directive: '%M', description: 'Minute (00–59)', example: '00–59' },
      { directive: '%S', description: 'Second (00–60)', example: '00–60' },
      { directive: '%f', description: 'Microseconds (6 digits)', example: '000000' },
      { directive: '%3N', description: 'Milliseconds (3 digits)', example: '123' },
      { directive: '%6N', description: 'Microseconds (6 digits)', example: '123456' },
      { directive: '%9N', description: 'Nanoseconds (9 digits)', example: '123456789' },
      { directive: '%N', description: 'Nanoseconds (same as %9N)', example: '123456789' },
      { directive: '%1N', description: 'Subseconds (1 digit)', example: '1' },
      { directive: '%2N', description: 'Subseconds (2 digits)', example: '12' },
      { directive: '%4N', description: 'Subseconds (4 digits)', example: '1234' },
      { directive: '%5N', description: 'Subseconds (5 digits)', example: '12345' },
      { directive: '%7N', description: 'Subseconds (7 digits)', example: '1234567' },
      { directive: '%8N', description: 'Subseconds (8 digits)', example: '12345678' },
      { directive: '%Q', description: 'Milliseconds (same as %3Q)', example: '123' },
      { directive: '%3Q', description: 'Milliseconds (3 digits)', example: '123' },
      { directive: '%6Q', description: 'Microseconds (6 digits)', example: '123456' },
      { directive: '%9Q', description: 'Nanoseconds (9 digits)', example: '123456789' },
      { directive: '%s', description: 'Unix epoch seconds', example: '1706745600' },
    ],
  },
  {
    name: 'Timezone',
    directives: [
      { directive: '%Z', description: 'Timezone abbreviation', example: 'UTC, EST' },
      { directive: '%z', description: 'UTC offset (+HHMM)', example: '+0000, -0500' },
      { directive: '%:z', description: 'UTC offset (+HH:MM)', example: '+00:00' },
      { directive: '%::z', description: 'UTC offset (+HH:MM:SS)', example: '+00:00:00' },
    ],
  },
  {
    name: 'Composite',
    directives: [
      { directive: '%F', description: 'ISO date (%Y-%m-%d)', example: '2024-01-31' },
      { directive: '%T', description: 'ISO time (%H:%M:%S)', example: '14:30:00' },
      { directive: '%R', description: 'Time (%H:%M)', example: '14:30' },
      { directive: '%c', description: 'Locale date and time', example: 'Mon Jan 31 14:30:00 2024' },
      { directive: '%x', description: 'Locale date', example: '01/31/2024' },
      { directive: '%X', description: 'Locale time', example: '14:30:00' },
      { directive: '%D', description: 'Date (%m/%d/%y)', example: '01/31/24' },
      { directive: '%r', description: '12-hour time (%I:%M:%S %p)', example: '02:30:00 PM' },
    ],
  },
  {
    name: 'Other',
    directives: [
      { directive: '%n', description: 'Newline character', example: '\\n' },
      { directive: '%t', description: 'Tab character', example: '\\t' },
      { directive: '%%', description: 'Literal % character', example: '%' },
      { directive: '%V', description: 'ISO 8601 week number', example: '01–53' },
      { directive: '%U', description: 'Week number (Sun start)', example: '00–53' },
      { directive: '%W', description: 'Week number (Mon start)', example: '00–53' },
    ],
  },
];

/**
 * What each fallback rule should say when it, rather than the event text,
 * supplied `_time`. A timestamp that came from the clock or the event before it
 * is indistinguishable from a parsed one in the output, which is the whole
 * reason for badging it.
 */
export const FALLBACK_LABEL: Partial<Record<TimeSource, string>> = {
  'previous-event': 'From previous event',
  'current-time': 'From index time',
  'datetime-config-current': 'DATETIME_CONFIG = CURRENT',
  'datetime-config-none': 'DATETIME_CONFIG = NONE',
};
