import { describe, it, expect, beforeAll } from 'vitest';
import { createResolver, type AuthoredLibrary, type Resolver } from '../src/index.js';
import { entitySchema } from '@eraserlabs/protocol/schema';

/** Kind-owned `not` exclusions format as a named "not allowed" property, not AJV's bare text. */
const library: AuthoredLibrary = {
  manifest: ['Node'],
  schemas: {
    Node: entitySchema('Node', {}),
  },
  templates: [
    {
      name: 'Node',
      html: '<template name="Node"><div data-tpl="Node" data-role="body"></div></template>',
      css: '',
    },
  ],
  baseCss: '',
};

let resolver: Resolver;
beforeAll(async () => {
  resolver = await createResolver({ library });
});

describe('not-exclusion formatting', () => {
  it('names the forbidden kind-owned property', async () => {
    const result = await resolver.resolve({
      elements: [{ tag: 'Node', id: 'n', x: 0, y: 0, from: 'other' }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toBe(
      'Property "from" is not allowed on tag "Node" at /elements/0.',
    );
  });
});
