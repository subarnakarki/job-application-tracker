import type { Application } from '@jat/shared';

/** Column order of the export. */
const COLUMNS: {
  header: string;
  value: (application: Application) => string | number | boolean | null;
}[] = [
  { header: 'Company', value: (a) => a.company },
  { header: 'Role', value: (a) => a.role },
  { header: 'Status', value: (a) => a.status },
  { header: 'Date applied', value: (a) => a.dateApplied },
  { header: 'Source', value: (a) => a.source },
  { header: 'Salary min', value: (a) => a.salaryMin },
  { header: 'Salary max', value: (a) => a.salaryMax },
  { header: 'Currency', value: (a) => a.salaryCurrency },
  { header: 'Job link', value: (a) => a.jobLink },
  { header: 'Location', value: (a) => a.location },
  { header: 'Work mode', value: (a) => a.workMode },
  { header: 'Posted on', value: (a) => a.postedOn },
  { header: 'Contact', value: (a) => a.contact },
  { header: 'Lead', value: (a) => a.leadName },
  { header: 'Next step', value: (a) => a.nextStep },
  { header: 'Next step date', value: (a) => a.nextStepDate },
  { header: 'Notes', value: (a) => a.notes },
  { header: 'Needs follow-up', value: (a) => a.needsFollowUp },
  { header: 'Created (UTC)', value: (a) => a.createdAt },
  { header: 'Updated (UTC)', value: (a) => a.updatedAt },
];

/**
 * One CSV cell. Text a spreadsheet would treat as a formula (starting with
 * = + - @, tab or carriage return) gets a leading apostrophe, so opening an
 * export never runs anything. Cells with commas, quotes or line breaks are
 * quoted (RFC 4180). Numbers are written as-is, so negative numbers stay numbers.
 */
export function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The whole file: a UTF-8 byte-order mark (so Excel reads accents), a header row, CRLF line ends. */
export function toCsv(applications: readonly Application[]): string {
  const rows = [
    COLUMNS.map((column) => csvCell(column.header)).join(','),
    ...applications.map((application) =>
      COLUMNS.map((column) => csvCell(column.value(application))).join(','),
    ),
  ];
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}
