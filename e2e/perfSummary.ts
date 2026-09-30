import { appendFileSync } from 'node:fs';

/**
 * Append a table to the GitHub job summary, when there is one.
 *
 * The budgets fail a run; this is what shows the drift before they do. Numbers
 * that only exist in a passing run's log are numbers nobody reads, so each perf
 * spec writes its measurements — and the budget beside each — to the summary
 * page of the run. Outside Actions `GITHUB_STEP_SUMMARY` is unset and this does
 * nothing; a summary that cannot be written must never fail a perf test.
 */
export interface SummaryRow {
  name: string;
  value: number | string;
  unit?: string;
  /** The limit the value is asserted against, when there is one. */
  budget?: number;
}

export function writeJobSummary(title: string, rows: SummaryRow[]): void {
  const file = process.env['GITHUB_STEP_SUMMARY'];
  if (!file) return;
  const cell = (value: number | string, unit?: string) =>
    `${typeof value === 'number' ? Math.round(value).toLocaleString('en-GB') : value}${unit ? ` ${unit}` : ''}`;
  const lines = [
    `### ${title}`,
    '',
    '| Metric | Measured | Budget | Headroom |',
    '| --- | ---: | ---: | ---: |',
    ...rows.map((row) => {
      const hasBudget = row.budget !== undefined && typeof row.value === 'number';
      const headroom = hasBudget ? `${Math.round((1 - (row.value as number) / row.budget!) * 100)}%` : '';
      return `| ${row.name} | ${cell(row.value, row.unit)} | ${row.budget === undefined ? '' : cell(row.budget, row.unit)} | ${headroom} |`;
    }),
    '',
  ];
  try {
    appendFileSync(file, `${lines.join('\n')}\n`);
  } catch (error) {
    console.warn(`could not write the job summary: ${String(error)}`);
  }
}
