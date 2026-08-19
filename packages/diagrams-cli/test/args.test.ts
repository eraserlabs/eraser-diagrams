import { describe, expect, it } from 'vitest';
import { choiceFlag, numberFlag, parseCliArgs, USAGE } from '../src/args.js';
import { CliError } from '../src/errors.js';

describe('parseCliArgs', () => {
  it('no arguments, -h, --help → help', () => {
    expect(parseCliArgs([]).help).toBe(true);
    expect(parseCliArgs(['-h']).help).toBe(true);
    expect(parseCliArgs(['--help']).command).toBeNull();
  });

  it('-v / --version', () => {
    expect(parseCliArgs(['-v']).version).toBe(true);
    expect(parseCliArgs(['--version']).version).toBe(true);
  });

  it('unknown command is a usage error carrying the usage text', () => {
    expect(() => parseCliArgs(['paint', 'x.json'])).toThrow(CliError);
    expect(() => parseCliArgs(['paint'])).toThrow(USAGE.slice(0, 30));
  });

  it('render: aliases, "-" as an option value, "--" before dash-prefixed inputs', () => {
    const parsed = parseCliArgs([
      'render',
      'a.json',
      '-o',
      '-',
      '-f',
      'html',
      '--scale',
      '2',
      '--json',
      '--',
      '-weird.json',
    ]);

    expect(parsed.command).toBe('render');
    expect(parsed.positionals).toEqual(['a.json', '-weird.json']);
    expect(parsed.flags['out']).toBe('-');
    expect(parsed.flags['format']).toBe('html');
    expect(parsed.flags['scale']).toBe('2');
    expect(parsed.flags['json']).toBe(true);
  });

  it('a lone "-" is a positional (stdin)', () => {
    expect(parseCliArgs(['validate', '-']).positionals).toEqual(['-']);
  });

  it('per-command help flag', () => {
    expect(parseCliArgs(['render', '--help']).help).toBe(true);
  });

  it('unknown flag / flag from another command → exit 2 with a hint', () => {
    expect(() => parseCliArgs(['render', 'a.json', '--bogus'])).toThrow(/Unknown option '--bogus'/);
    expect(() => parseCliArgs(['validate', 'a.json', '--scale', '2'])).toThrow(CliError);

    try {
      parseCliArgs(['validate', 'a.json', '--scale', '2']);
    } catch (error) {
      expect((error as CliError).exitCode).toBe(2);
      expect((error as CliError).message).toContain('eraser-diagrams validate --help');
    }
  });

  it('ambiguous short-option value and boolean-with-value are usage errors', () => {
    expect(() => parseCliArgs(['render', 'a.json', '-o', '-f', 'x.png'])).toThrow(CliError);
    expect(() => parseCliArgs(['render', 'a.json', '--json=false'])).toThrow(CliError);
  });
});

describe('typed flag readers', () => {
  it('numberFlag accepts positive numbers only', () => {
    expect(numberFlag({ scale: '2' }, 'scale')).toBe(2);
    expect(numberFlag({}, 'scale')).toBeUndefined();
    expect(() => numberFlag({ scale: 'two' }, 'scale')).toThrow(
      /--scale expects a positive number/,
    );
    expect(() => numberFlag({ scale: '0' }, 'scale')).toThrow(CliError);
  });

  it('choiceFlag restricts to the given choices', () => {
    expect(choiceFlag({ format: 'html' }, 'format', ['png', 'html'])).toBe('html');
    expect(() => choiceFlag({ format: 'svg' }, 'format', ['png', 'html'])).toThrow(/png\|html/);
  });
});
