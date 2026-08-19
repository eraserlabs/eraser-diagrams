/**
 * Visual + measured-geometry goldens over the repo-root fixture corpus.
 *
 * Every fixture under fixtures/features and fixtures/corpus renders through the real pipeline
 * (stock library, bundled fonts, live icon service behind a local disk cache) into a PNG and the
 * measured JSON. Both are compared against baselines in fixtures/__goldens__ by Playwright's own
 * snapshot machinery: pixel diff for the PNG, line diff for the JSON.
 *
 *   pnpm snap           compare against baselines (opens the HTML report when something differs)
 *   pnpm snap:sheet     contact sheet of every fixture, changed ones first
 *   pnpm snap:update    accept the current output as the new baseline
 *
 * Tagged @golden so `test:e2e` (behavioural specs) and `snap` (regression baselines) stay separate.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { DiagramInput } from '@eraserlabs/resolve';
import { createEraserIconLoader, createRenderer, type Renderer } from '../src/index.js';
import { CHROMIUM_PATH } from './support/browser.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(HERE, '..', '..', '..', 'fixtures');
const ICON_CACHE_DIR = join(FIXTURES_ROOT, '.icon-cache');
const GROUPS = ['features', 'corpus'] as const;
/** Sub-pixel text metrics are stable per machine; 0.01 px keeps the diff readable, not noisy. */
const COORD_DECIMALS = 2;
const MAX_DIFF_PIXEL_RATIO = 0.001;

interface Fixture {
  group: (typeof GROUPS)[number];
  name: string;
  file: string;
}

/** `errors-*` fixtures exist to fail resolution; they have no picture to pin. */
function listFixtures(): Fixture[] {
  return GROUPS.flatMap((group) =>
    readdirSync(join(FIXTURES_ROOT, group))
      .filter((f) => f.endsWith('.json') && !f.startsWith('errors-'))
      .sort()
      .map((f) => ({ group, name: f.replace(/\.json$/, ''), file: join(FIXTURES_ROOT, group, f) })),
  );
}

/** Either document envelope, or the app's `{ definition: { elements } }` export. */
function readDocument(file: string): DiagramInput {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const doc = raw as { definition?: { elements?: unknown[] } };
  if (doc.definition?.elements) {
    return { elements: doc.definition.elements } as DiagramInput;
  }

  return raw as DiagramInput;
}

function roundNumbers<T>(value: T): T {
  if (typeof value === 'number') {
    return Number(value.toFixed(COORD_DECIMALS)) as T;
  }
  if (Array.isArray(value)) {
    return value.map(roundNumbers) as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, roundNumbers(v)]),
    ) as T;
  }

  return value;
}

let renderer: Renderer;

test.beforeAll(async () => {
  renderer = await createRenderer({
    chromiumPath: CHROMIUM_PATH,
    iconLoader: createEraserIconLoader({
      cacheDir: ICON_CACHE_DIR,
      cacheTtlMs: Number.MAX_SAFE_INTEGER,
    }),
    deviceScaleFactor: 1,
  });
});

test.afterAll(async () => {
  await renderer?.close();
});

for (const fixture of listFixtures()) {
  test(`${fixture.group}/${fixture.name}`, { tag: '@golden' }, async () => {
    // First run on a machine fetches every icon over the network before the cache is warm.
    test.setTimeout(90_000);
    const outcome = await renderer.render({
      ...readDocument(fixture.file),
      outputs: { png: true, json: true },
    });

    if (!outcome.ok) {
      throw new Error(`render failed: ${JSON.stringify(outcome.errors, null, 2)}`);
    }

    const measured = {
      warnings: outcome.warnings.map((w) => `${w.code} ${w.path}`).sort(),
      ...roundNumbers(outcome.json),
    };

    // Soft: a pixel mismatch must not hide the JSON diff that says which element moved.
    expect.soft(outcome.png).toMatchSnapshot([fixture.group, `${fixture.name}.png`], {
      maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    });
    expect(`${JSON.stringify(measured, null, 2)}\n`).toMatchSnapshot([
      fixture.group,
      `${fixture.name}.json`,
    ]);
  });
}
