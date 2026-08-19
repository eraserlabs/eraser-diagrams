import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AuthoredElement } from '@eraserlabs/resolve';
import { stubIconLoader } from './support/stubIcons.js';
import { createRenderer, type Renderer } from '../src/diagrams.js';
import { stockLibrary } from '../src/library/index.js';
import { CHROMIUM_PATH } from './support/browser.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../fixtures/features/elements-connections.json', import.meta.url),
    'utf8',
  ),
) as { elements: unknown[] };
const AHEM_PATH = fileURLToPath(new URL('../fixtures/Ahem.ttf', import.meta.url));
const FAMILY = 'AhemTest';

let diagrams: Renderer;

beforeAll(async () => {
  diagrams = await createRenderer({
    library: stockLibrary,
    chromiumPath: CHROMIUM_PATH,
    iconLoader: stubIconLoader,
    fonts: {
      roles: { rough: FAMILY, clean: FAMILY, mono: FAMILY },
      faces: [{ kind: 'file', family: FAMILY, path: AHEM_PATH }],
    },
  });
});

afterAll(async () => {
  await diagrams.close();
});

describe('elements-connections proving ground', () => {
  it('serializes transparent labels with real SVG gaps only on labeled relationships', async () => {
    const outcome = await diagrams.render({
      elements: fixture.elements as AuthoredElement[],
      outputs: { html: true },
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);

    if (!outcome.ok) {
      return;
    }

    const masks = [
      ...outcome.html.matchAll(/<mask id="([^"]+)"[^>]*data-mdp-connection-mask="([^"]+)"/g),
    ].map(([, maskId, connectionId]) => ({ maskId, connectionId }));
    const labeled = ['rel-elbow-label', 'rel-straight-label', 'rel-bidirectional'];

    expect(masks.map(({ connectionId }) => connectionId).sort()).toEqual([...labeled].sort());
    expect(new Set(masks.map(({ maskId }) => maskId)).size).toBe(masks.length);
    expect(outcome.html.match(/data-mdp-label-cutout=""/g)).toHaveLength(labeled.length);

    for (const { maskId } of masks) {
      expect(outcome.html).toContain(`mask="url(#${maskId})"`);
    }

    for (const id of ['rel-dashed', 'rel-dotted-noarrow']) {
      expect(outcome.html).not.toContain(`data-mdp-connection-mask="${id}"`);
    }

    expect(outcome.html).toMatch(/\.er-rel__label\{[^}]*background:transparent/);
  });
});
