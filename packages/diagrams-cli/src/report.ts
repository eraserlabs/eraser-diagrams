import type { Issue } from '@eraserlabs/resolve';

export interface InputResult {
  input: string;
  out?: string;
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  /** Wall-clock for this input, when it was processed. */
  ms?: number;
  timingsMs?: Record<string, number>;
}

export interface Report {
  ok: boolean;
  degradedFonts: string[];
  results: InputResult[];
}

export interface ReportOptions {
  quiet: boolean;
  debug: boolean;
  failOnWarning: boolean;
}

export function buildReport(
  results: InputResult[],
  degradedFonts: string[],
  failOnWarning: boolean,
): Report {
  const anyWarning = degradedFonts.length > 0 || results.some((r) => r.warnings.length > 0);
  const ok = results.every((r) => r.ok) && !(failOnWarning && anyWarning);

  return { ok, degradedFonts, results };
}

function issueLine(issue: Issue): string {
  const element =
    issue.tag !== undefined ? ` (${issue.tag}${issue.elementId ? `#${issue.elementId}` : ''})` : '';
  const suggestion = issue.suggestion !== undefined ? ` Did you mean "${issue.suggestion}"?` : '';

  return `  ${issue.severity.padEnd(7)} ${issue.code} ${issue.path}${element} — ${issue.message}${suggestion}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function statusLine(result: InputResult): string {
  if (!result.ok) {
    const codes = [...new Set(result.errors.map((issue) => issue.code))].join(', ');

    return `FAIL  ${result.input}  ${codes}`;
  }

  const parts = [result.input];

  if (result.out !== undefined) {
    parts.push(`→ ${result.out}`);
  }

  if (result.ms !== undefined) {
    parts.push(`${result.ms} ms`);
  }

  if (result.warnings.length > 0) {
    parts.push(count(result.warnings.length, 'warning'));
  }

  return `ok    ${parts.join('  ')}`;
}

/** Human report on stderr: one status line per input, then its issues. Errors always print. */
export function formatHuman(report: Report, options: ReportOptions): string {
  const lines: string[] = [];

  if (report.degradedFonts.length > 0) {
    lines.push(`warning degraded fonts: ${report.degradedFonts.join(', ')}`);
  }

  for (const result of report.results) {
    if (!options.quiet || !result.ok) {
      lines.push(statusLine(result));
    }

    for (const issue of result.errors) {
      lines.push(issueLine(issue));
    }

    if (!options.quiet) {
      for (const issue of result.warnings) {
        lines.push(issueLine(issue));
      }
    }
  }

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export function formatJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** `--debug`: stage timing table. Indented rows are the resolver's internal split. */
export function formatTimings(title: string, timings: Record<string, number>): string {
  const rows = Object.entries(timings).map(([stage, ms]) => {
    const label = stage.startsWith('resolve.') ? `  ${stage.slice('resolve.'.length)}` : stage;

    return [label, `${ms.toFixed(1)} ms`] as const;
  });
  const width = Math.max(...rows.map(([label]) => label.length));
  const body = rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value.padStart(9)}`);

  return `\n${title}\n${body.join('\n')}\n`;
}
