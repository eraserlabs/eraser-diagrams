import type { Issue } from '@eraserlabs/resolve';
import { describe, expect, it } from 'vitest';
import {
  buildReport,
  formatHuman,
  formatJson,
  formatTimings,
  type InputResult,
} from '../src/report.js';

const warning: Issue = {
  code: 'W_UNKNOWN_ICON',
  severity: 'warning',
  path: '/1/icon',
  elementIndex: 1,
  elementId: 'api',
  tag: 'Icon',
  message: 'Unknown icon "nodejs"; using a placeholder glyph.',
};
const error: Issue = {
  code: 'E_UNKNOWN_TAG',
  severity: 'error',
  path: '/0',
  elementIndex: 0,
  tag: 'Shpe',
  message: 'Unknown tag "Shpe".',
  suggestion: 'Shape',
};

const good: InputResult = {
  input: 'a.json',
  out: 'out/a.png',
  ok: true,
  errors: [],
  warnings: [warning],
  ms: 412,
};
const bad: InputResult = { input: 'b.json', ok: false, errors: [error, error], warnings: [] };

describe('buildReport', () => {
  it('ok only when every input is ok', () => {
    expect(buildReport([good], [], false).ok).toBe(true);
    expect(buildReport([good, bad], [], false).ok).toBe(false);
  });

  it('--fail-on-warning trips on issue warnings and on degraded fonts', () => {
    expect(buildReport([good], [], true).ok).toBe(false);
    expect(buildReport([{ ...good, warnings: [] }], ['Inter'], true).ok).toBe(false);
    expect(buildReport([{ ...good, warnings: [] }], ['Inter'], false).ok).toBe(true);
  });
});

describe('formatHuman', () => {
  const options = { quiet: false, debug: false, failOnWarning: false };

  it('one status line per input, then its issues', () => {
    const text = formatHuman(buildReport([good, bad], ['Inter'], false), options);
    expect(text).toBe(
      [
        'warning degraded fonts: Inter',
        'ok    a.json  → out/a.png  412 ms  1 warning',
        '  warning W_UNKNOWN_ICON /1/icon (Icon#api) — Unknown icon "nodejs"; using a placeholder glyph.',
        'FAIL  b.json  E_UNKNOWN_TAG',
        '  error   E_UNKNOWN_TAG /0 (Shpe) — Unknown tag "Shpe". Did you mean "Shape"?',
        '  error   E_UNKNOWN_TAG /0 (Shpe) — Unknown tag "Shpe". Did you mean "Shape"?',
        '',
      ].join('\n'),
    );
  });

  it('--quiet drops ok lines and warnings but keeps failures', () => {
    const text = formatHuman(buildReport([good, bad], [], false), { ...options, quiet: true });
    expect(text).not.toContain('ok    a.json');
    expect(text).not.toContain('W_UNKNOWN_ICON');
    expect(text).toContain('FAIL  b.json');
    expect(text).toContain('E_UNKNOWN_TAG /0');
  });

  it('is empty when there is nothing to say', () => {
    expect(
      formatHuman(buildReport([{ ...good, warnings: [] }], [], false), { ...options, quiet: true }),
    ).toBe('');
  });
});

describe('formatJson', () => {
  it('serializes the report shape', () => {
    const parsed = JSON.parse(formatJson(buildReport([good, bad], [], false)));
    expect(parsed).toMatchObject({
      ok: false,
      degradedFonts: [],
      results: [
        { input: 'a.json', ok: true },
        { input: 'b.json', ok: false },
      ],
    });
    expect(parsed.results[1].errors).toHaveLength(2);
  });
});

describe('formatTimings', () => {
  it('indents resolver sub-stages and right-aligns values', () => {
    const text = formatTimings('Timings: a.json', {
      resolve: 12.345,
      'resolve.schema': 1,
      browserRun: 100,
    });
    expect(text).toContain('Timings: a.json');
    expect(text).toContain('  resolve       12.3 ms');
    expect(text).toContain('    schema       1.0 ms');
    expect(text).toContain('  browserRun   100.0 ms');
  });
});
