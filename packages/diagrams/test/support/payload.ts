import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { ResolvedConnection, ResolvedEntity } from '@eraserlabs/protocol';
// Type-only: the window.__eraser global declaration for the evaluate callbacks below.
import type { PageSetup, RunResult } from '@eraserlabs/render/browser';
import {
  createResolver,
  type DiagramInput,
  type AuthoredLibrary,
  type ElementNormalizer,
  type IconLoader,
  type ResolveResult,
  type TemplateOverrides,
} from '@eraserlabs/resolve';
import { stubIconLoader } from './stubIcons.js';
import { buildRenderPageSetup, stockLibrary, stockNormalizers } from '../../src/index.js';
import { stageFonts, type StagedFonts } from '../../src/fonts/staging.js';
import { injectFonts, prepareFontsRequest } from '../../src/fonts/inject.js';

/** Build `window.__eraser` payloads straight from the resolver's data output. */

export interface RenderPayload {
  templates: PageSetup['templates'];
  baseCss: string;
  washMaster?: string;
  entities: ResolvedEntity[];
  connections: ResolvedConnection[];
  icons: Record<string, string>;
}

export type { RunResult, ElementMeasure } from '@eraserlabs/render/browser';

const HERE = dirname(fileURLToPath(import.meta.url));
export const IIFE_PATH = join(
  HERE,
  '..',
  '..',
  '..',
  'render',
  'dist',
  'browser',
  'eraser-render.iife.js',
);
const FIXTURES_DIR = join(HERE, '..', '..', '..', '..', 'fixtures', 'features');

/** Fixtures on disk are already the `{ elements }` / `{ entities, connections }` document form. */
export function readFixture(name: string): DiagramInput {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8')) as DiagramInput;
}

export interface BuildPayloadOptions {
  overrides?: TemplateOverrides;
  iconLoader?: IconLoader;
  /** Swap the whole vocabulary — the custom-library suite drives the pipeline with its own tags. */
  library?: AuthoredLibrary;
  normalizers?: Record<string, ElementNormalizer>;
}

/** Resolve an input against the stock library (or a caller-supplied one) and package the payload. */
export async function buildPayload(
  input: unknown,
  options: BuildPayloadOptions = {},
): Promise<{ payload: RenderPayload; result: ResolveResult }> {
  const resolver = await createResolver({
    library: options.library ?? stockLibrary,
    ...(options.overrides ? { overrides: options.overrides } : {}),
    normalizers: options.normalizers ?? stockNormalizers,
    iconLoader: options.iconLoader ?? stubIconLoader,
  });
  const result = await resolver.resolve(input);
  const pageSetup = buildRenderPageSetup(resolver.library);
  const payload: RenderPayload = {
    templates: pageSetup.templates,
    baseCss: pageSetup.baseCss,
    ...(pageSetup.washMaster !== undefined ? { washMaster: pageSetup.washMaster } : {}),
    entities: result.entities ?? [],
    connections: result.connections ?? [],
    icons: result.icons ?? {},
  };

  return { payload, result };
}

/** Load the render IIFE, open a blank page, and run the browser pipeline over the payload. */
export async function runPayload(
  page: Page,
  payload: RenderPayload,
  fonts?: StagedFonts,
): Promise<RunResult> {
  await page.addInitScript({ path: IIFE_PATH });
  // Standards mode — about:blank is quirks mode, breaking percentage heights (see diagrams.ts).
  await page.goto('data:text/html,<!doctype html><html><head></head><body></body></html>');
  await page.evaluate((setup) => window.__eraser.setup(setup), {
    templates: payload.templates,
    baseCss: payload.baseCss,
    ...(payload.washMaster !== undefined ? { washMaster: payload.washMaster } : {}),
  });

  if (fonts) {
    await injectFonts(page, prepareFontsRequest(fonts));
  }

  return page.evaluate((request) => window.__eraser.run(request), {
    entities: payload.entities,
    connections: payload.connections,
    icons: payload.icons,
  });
}

export const AHEM_PATH = join(HERE, '..', '..', 'fixtures', 'Ahem.ttf');

/** Stage the Ahem fixture for every font role — deterministic metrics (each glyph = 1em). */
export function stageAhem(): Promise<StagedFonts> {
  const family = 'AhemTest';

  return stageFonts({
    roles: { rough: family, clean: family, mono: family },
    faces: [{ kind: 'file', family, path: AHEM_PATH }],
  });
}
