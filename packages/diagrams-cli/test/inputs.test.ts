import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { outputName, readInput, unwrapDocument } from '../src/inputs.js';

describe('unwrapDocument', () => {
  it('passes every accepted document form through untouched', () => {
    expect(unwrapDocument([1])).toEqual({ document: [1], unwrapped: false });
    expect(unwrapDocument({ title: 't', elements: [1] })).toEqual({
      document: { title: 't', elements: [1] },
      unwrapped: false,
    });
    expect(unwrapDocument({ entities: [1], connections: [] })).toEqual({
      document: { entities: [1], connections: [] },
      unwrapped: false,
    });
  });

  it('lifts the app export wrapper { definition: { elements } }', () => {
    expect(unwrapDocument({ definition: { elements: [2] } })).toEqual({
      document: { elements: [2] },
      unwrapped: true,
    });
  });

  it('leaves other shapes for the resolver to reject', () => {
    expect(unwrapDocument({ elements: 'nope' })).toEqual({
      document: { elements: 'nope' },
      unwrapped: false,
    });
    expect(unwrapDocument('x')).toEqual({ document: 'x', unwrapped: false });
  });
});

describe('readInput', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eraser-cli-inputs-'));

  it('reads a file and stdin', () => {
    const file = join(dir, 'ok.json');
    writeFileSync(file, '[{"tag":"Shape"}]');
    expect(readInput(file)).toEqual({ ok: true, document: [{ tag: 'Shape' }], unwrapped: false });
    expect(readInput('-', () => '{"elements":[]}')).toEqual({
      ok: true,
      document: { elements: [] },
      unwrapped: false,
    });
  });

  it('reports unreadable files and bad JSON as per-input failures', () => {
    const missing = readInput(join(dir, 'missing.json'));
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.message).toMatch(/Cannot read .*missing\.json/);

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    const result = readInput(bad);
    expect(!result.ok && result.message).toMatch(/Invalid JSON in .*bad\.json/);
  });
});

describe('outputName', () => {
  it('swaps the extension, and names stdin output diagram.<format>', () => {
    expect(outputName('dir/arch.json', 'png')).toBe('arch.png');
    expect(outputName('arch', 'html')).toBe('arch.html');
    expect(outputName('-', 'png')).toBe('diagram.png');
  });
});
