import { describe, it, expect } from 'vitest';
import { propRows } from '../src/lib/schemaProps.js';

const iconSchema = {
  type: 'object',
  required: ['tag', 'id', 'x', 'y', 'name'],
  properties: {
    tag: { const: 'Icon' },
    id: { type: 'string' },
    x: { type: 'number' },
    y: { type: 'number' },
    name: { type: 'string', 'x-icon-name': true },
    size: { type: 'number', enum: [32, 50, 72, 100] },
    caption: { type: 'string', 'x-content': 'plain', default: '' },
  },
};

describe('propRows (API-reference derivation)', () => {
  const rows = propRows(iconSchema);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

  it('excludes the tag discriminator', () => {
    expect(byName.tag).toBeUndefined();
  });

  it('marks required vs optional', () => {
    expect(byName.id!.required).toBe(true);
    expect(byName.name!.required).toBe(true);
    expect(byName.caption!.required).toBe(false);
  });

  it('surfaces enum values', () => {
    expect(byName.size!.type).toBe('enum');
    expect(byName.size!.enum).toEqual(['32', '50', '72', '100']);
  });

  it('annotates custom keywords and defaults', () => {
    expect(byName.name!.note).toBe('icon name');
    expect(byName.caption!.note).toBe('sanitized text');
    expect(byName.caption!.default).toBe('');
  });
});
