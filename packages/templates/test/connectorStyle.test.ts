import { describe, expect, it } from 'vitest';
import { CONNECTOR_STYLES } from '../src/schema/enums.js';
import { Relationship } from '../src/templates/Relationship/Relationship.schema.js';

/** A Relationship can be drawn as an elbow, a straight line, or an arc with a bend. */
describe('Relationship connector styles', () => {
  it('accepts elbow, straight and arc', () => {
    expect(CONNECTOR_STYLES).toEqual(['elbow', 'straight', 'arc']);
  });

  it('has a numeric bend prop', () => {
    expect(JSON.stringify(Relationship)).toContain('"bend":{"type":"number"');
  });
});
