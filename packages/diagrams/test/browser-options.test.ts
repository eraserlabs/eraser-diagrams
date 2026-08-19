import { describe, expect, it } from 'vitest';
import { createRenderer, type RendererOptions } from '../src/diagrams.js';
import { stockLibrary } from '../src/library/index.js';

describe('browser ownership', () => {
  it('rejects JavaScript callers that omit both chromiumPath and browser', async () => {
    const options = { library: stockLibrary } as RendererOptions;

    await expect(createRenderer(options)).rejects.toThrow(
      'createRenderer requires either chromiumPath or browser.',
    );
  });
});
