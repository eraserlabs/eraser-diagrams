import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { buildHtmlDocument, type Box, type SceneLayout } from '@eraserlabs/render';
// Value import is type-only in effect; it also pulls in the window.__eraser global declaration.
import type { RunResult } from '@eraserlabs/render/browser';
import { TimeTracker } from '@eraserlabs/utils';
import {
  createResolver,
  type AuthoredConnection,
  type AuthoredEntity,
  type AuthoredLibrary,
  type AuthoredRecord,
  type DiagramInput,
  type ElementNormalizer,
  type FontsConfig,
  type IconLoader,
  type Issue,
  type RegistryInfo,
  type TemplateOverrides,
  type ValidationResult,
} from '@eraserlabs/resolve';
import { stockLibrary } from './library/index.js';
import { stockNormalizers } from './library/normalizers.js';
import { buildRenderPageSetup } from './library/pageSetup.js';
import { createEraserIconLoader } from './icons/eraserLoader.js';
import { stageFonts, type StagedFonts } from './fonts/staging.js';
import { injectFonts, prepareFontsRequest } from './fonts/inject.js';
import { buildEmbeddedFontCss } from './fonts/embed.js';
import { eraserFonts } from './fonts/eraserFonts.js';

/**
 * Supplies the Chromium the orchestrator drives. This covers caller-managed browsers and
 * remote fleets (`chromium.connectOverCDP(wsUrl)`, e.g. browserless.io or Cloudflare Browser
 * Run). Callers launching a local browser can provide `chromiumPath` instead.
 *
 * A provider owns its browser's flags. If you use `url` font faces served from localhost or a
 * private network, launch with `--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests`
 * — the render page is origin-less, so Chromium's Local Network Access checks silently block its
 * font fetches otherwise. The `chromiumPath` path applies these flags for you.
 */
export type BrowserProvider = () => Promise<Browser>;

interface CommonRendererOptions {
  /** The visual vocabulary to render with. Defaults to the stock Eraser library. */
  library?: AuthoredLibrary;
  overrides?: TemplateOverrides;
  /**
   * Per-tag derived-prop table paired with `library`. Defaults to the stock Eraser table; a custom
   * vocabulary supplies its own (or `{}` for none) — entries for absent tags never fire.
   */
  normalizers?: Record<string, ElementNormalizer>;
  iconLoader?: IconLoader;
  fonts?: FontsConfig;
  onUnknownIcon?: 'placeholder' | 'error';
  /** Warm page pool size. */
  pages?: number;
  /** Pixel density used for Chromium screenshots. */
  deviceScaleFactor?: number;
  /**
   * The outputs a request that omits `outputs` should produce. Defaults to `{ png: true }`. A
   * request's own `outputs` replaces this wholesale — the two are never merged flag by flag.
   */
  outputs?: OutputRequest;
}

/** Chromium is caller-owned: provide a local executable or a complete browser provider. */
export type RendererOptions = CommonRendererOptions &
  ({ chromiumPath: string; browser?: never } | { browser: BrowserProvider; chromiumPath?: never });

/**
 * The outputs one render should produce, as independent flags. All requested outputs come from a
 * single resolve + browser pass. Omitting `outputs` requests `{ png: true }`; an explicit `{}`
 * runs the full pipeline for its warnings alone.
 */
export interface OutputRequest {
  /** Raster screenshot of the scene. */
  png?: boolean;
  /** HTML document. Fonts are referenced by source unless a file face sets `inline`. */
  html?: boolean;
  /** The diagram as data: elements with their measured geometry and routed connections. */
  json?: boolean;
}

/**
 * One measured element: the author's own object, with measured geometry overlaid — so the measured
 * types ARE the authored ones. That identity is the round trip stated in the type system: a `json`
 * result is a `DiagramInput`, so handing it straight back to `render` typechecks. A connection
 * authored without `tag` (split-form default) stays tag-less here too, which is exactly what
 * `AuthoredConnection` already allows.
 */
export type DiagramJsonEntity = AuthoredEntity;
export type DiagramJsonConnection = AuthoredConnection;
export type DiagramJsonElement = DiagramJsonEntity | DiagramJsonConnection;

/**
 * The measured diagram: **the authored document verbatim, plus measured geometry. Nothing else.**
 *
 * Every element is the object the author submitted — same property names, same values, palette
 * tokens still tokens, `size: "md"` still `"md"` — with only the measured overlay written on top.
 * Nothing the library interpreted appears: no translated colors, no derived props, no defaults,
 * no sanitizer rewrites, and no id for a connection whose author omitted one.
 *
 * That is the point rather than a nicety. The output is a document to re-submit, and a document
 * outlives the library that measured it: edit the palette or a template, hand the same JSON back,
 * and the new library must apply. Any library-interpreted value baked into the output would
 * freeze the old library's opinion into the document instead — the same reason a document names
 * an icon rather than carrying its fetched SVG.
 *
 * The split shape matches the authored `{ entities, connections }` form. Entity
 * `x`/`y`/`width`/`height` are the final scene-space boxes; connections carry their routed
 * `points` (and `labelPlacement` when a label was placed) in the element-relative frame the
 * authored schema uses.
 */
export interface DiagramJson {
  entities: DiagramJsonEntity[];
  connections: DiagramJsonConnection[];
  /** Bounding box of everything plus padding, in scene coordinates. */
  scene: Box;
}

/**
 * One render call: the diagram itself plus the outputs it should produce. `outputs` is a reserved
 * document key — `validate()` and `resolve()` ignore it silently, so a complete render request is
 * also a valid document.
 */
export type RenderRequest = DiagramInput & {
  /**
   * The outputs this render should produce. Omitted, the renderer's creation-time `outputs`
   * default applies (itself `{ png: true }`); when present it replaces that default wholesale
   * rather than merging with it flag by flag.
   */
  outputs?: OutputRequest;
};

/** The structural slice of a request the result type is keyed on. */
type OutputSelection = { outputs?: OutputRequest };

/** The output flags a call actually selected: an absent `outputs` key means `{ png: true }`. */
type RequestedOutputs<R extends OutputSelection> = R['outputs'] extends OutputRequest
  ? R['outputs']
  : { png: true };

/**
 * Maps one requested output flag to its result field: `true` makes the field required, absent or
 * `false` omits it, and a dynamic `boolean` request leaves it optional. The outer `keyof` guard
 * carries the absent case: indexing a literal request for a flag it never mentions widens to
 * `unknown`, which would otherwise land in the dynamic branch.
 */
type OutputField<O extends OutputRequest, K extends keyof OutputRequest, V> = K extends keyof O
  ? [O[K]] extends [true]
    ? { [P in K]: V }
    : [O[K]] extends [false | undefined]
      ? unknown
      : { [P in K]?: V }
  : unknown;

export type RenderFailure = { ok: false; errors: Issue[]; warnings: Issue[] };
export type RenderSuccess<R extends OutputSelection = { outputs: { png: true } }> = {
  ok: true;
  warnings: Issue[];
  timingsMs: Record<string, number>;
} & OutputField<RequestedOutputs<R>, 'png', Buffer> &
  OutputField<RequestedOutputs<R>, 'html', string> &
  OutputField<RequestedOutputs<R>, 'json', DiagramJson>;
export type RenderOutcome<R extends OutputSelection = { outputs: { png: true } }> =
  RenderSuccess<R> | RenderFailure;

export interface Renderer {
  /**
   * One argument: the diagram and its `outputs` in a single request object. A caller holding an
   * `unknown` document casts — validation is total at runtime regardless of what the types said.
   */
  render<const R extends RenderRequest>(request: R): Promise<RenderOutcome<R>>;
  validate(input: unknown): Promise<ValidationResult>;
  registryInfo(): RegistryInfo;
  tagSchema(tag: string): object | undefined;
  /** Families whose font faces failed to stage. */
  degradedFonts: string[];
  close(): Promise<void>;
}

const require = createRequire(import.meta.url);

/**
 * Rebuild the measured document from the PRISTINE authored elements, overlaying measured geometry
 * and nothing else. The resolver hands back each element's own submitted object alongside the id
 * the layout results are keyed by — the mutated clone the pipeline works on is a different object
 * and never reaches here, which is what makes the purity invariant structural rather than a list
 * of properties to remember to strip.
 *
 * The overlay: entities take their final scene boxes; connections take the routed polyline
 * re-expressed in the authored frame (origin `x`/`y` plus origin-relative `points`, label box as
 * `labelPlacement`). An element the layout did not measure is emitted exactly as authored.
 */
function toDiagramJson(authored: readonly AuthoredRecord[], layout: SceneLayout): DiagramJson {
  const entities: DiagramJsonEntity[] = [];
  const connections: DiagramJsonConnection[] = [];

  for (const { id, kind, source } of authored) {
    if (kind === 'entity') {
      // Deep copy: the result is the caller's to keep and mutate, and must not alias its own input.
      const element = structuredClone(source) as DiagramJsonEntity;
      const box = layout.boxes[id];

      if (box) {
        element.x = box.x;
        element.y = box.y;
        element.width = box.width;
        element.height = box.height;
      }

      entities.push(element);
      continue;
    }

    const element = structuredClone(source) as DiagramJsonConnection;
    const geometry = layout.connections[id];
    const origin = geometry?.points[0];

    if (geometry && origin) {
      const [originX, originY] = origin;
      const label = geometry.labelBox;
      element.x = originX;
      element.y = originY;
      element.points = geometry.points.map(([x, y]) => ({ x: x - originX, y: y - originY }));

      if (label) {
        // Measured label boxes are DOM floats; the document dialect is integer-grid.
        element.labelPlacement = {
          x: Math.round(label.x - originX),
          y: Math.round(label.y - originY),
          width: Math.round(label.width),
          height: Math.round(label.height),
        };
      }
    }

    connections.push(element);
  }

  return { entities, connections, scene: layout.scene };
}

/**
 * The orchestrator: warm Chromium, a pool of prepared pages (render IIFE + templates + fonts
 * injected once per page), and a single-argument `render(request)` producing any subset of
 * `{ png, html, json }` from one pass. Per request only `{ entities, connections, icons }` crosses
 * into the page — one evaluate, then one screenshot and/or serialize.
 */
export async function createRenderer(options: RendererOptions): Promise<Renderer> {
  const defaultOutputs: OutputRequest = options.outputs ?? { png: true };
  const browserProvider: BrowserProvider | undefined =
    options.browser ??
    (options.chromiumPath
      ? () =>
          chromium.launch({
            executablePath: options.chromiumPath,
            // Origin-less pages fetching http://127.0.0.1 fonts hit Local Network Access checks.
            args: [
              '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
            ],
          })
      : undefined);

  if (!browserProvider) {
    throw new TypeError('createRenderer requires either chromiumPath or browser.');
  }

  const resolver = await createResolver({
    library: options.library ?? stockLibrary,
    ...(options.overrides ? { overrides: options.overrides } : {}),
    normalizers: options.normalizers ?? stockNormalizers,
    // Default to the public Eraser icon bucket; a fetch failure degrades to placeholder + warning.
    iconLoader: options.iconLoader ?? createEraserIconLoader(),
    ...(options.onUnknownIcon ? { onUnknownIcon: options.onUnknownIcon } : {}),
  });

  const staged: StagedFonts = await stageFonts(options.fonts ?? eraserFonts());

  const iifePath = join(
    dirname(require.resolve('@eraserlabs/render/browser')),
    'eraser-render.iife.js',
  );
  const pageSetup = buildRenderPageSetup(resolver.library);

  const browser: Browser = await browserProvider();
  const context: BrowserContext = await browser.newContext({
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
  });

  const fontsRequest = staged ? prepareFontsRequest(staged) : undefined;

  async function preparePage(): Promise<Page> {
    const page = await context.newPage();
    await page.addInitScript({ path: iifePath });
    // A real doctype via navigation: about:blank is quirks mode, where percentage heights
    // resolve against the viewport through auto ancestors and auto-sized elements balloon to
    // page height. A data: URL is a true navigation, so the init script re-runs.
    await page.goto('data:text/html,<!doctype html><html><head></head><body></body></html>');
    await page.evaluate((setup) => window.__eraser.setup(setup), pageSetup);

    if (fontsRequest) {
      await injectFonts(page, fontsRequest);
    }

    return page;
  }

  const poolSize = Math.max(1, options.pages ?? 1);
  const pool = await Promise.all(Array.from({ length: poolSize }, preparePage));
  const waiters: ((page: Page) => void)[] = [];

  function acquire(): Promise<Page> {
    const page = pool.pop();

    if (page) {
      return Promise.resolve(page);
    }

    return new Promise((resolve) => waiters.push(resolve));
  }

  function release(page: Page): void {
    const waiter = waiters.shift();

    if (waiter) {
      waiter(page);

      return;
    }

    pool.push(page);
  }

  let embeddedFontCss: string | undefined;

  return {
    degradedFonts: staged?.degraded ?? [],

    validate: (input) => resolver.validate(input),

    registryInfo: () => resolver.registryInfo(),

    tagSchema: (tag) => resolver.tagSchema(tag),

    // Flag-shaped implementation behind the interface's output-typed generic.
    render: (async (request: RenderRequest) => {
      const requested: OutputRequest = request?.outputs ?? defaultOutputs;
      const tracker = new TimeTracker();

      const resolved = await resolver.resolve(request);
      tracker.mark('resolve');

      // Fold the resolver's per-stage split in under a prefix.
      tracker.merge('resolve', resolved.meta.timingsMs);

      if (!resolved.ok) {
        return { ok: false as const, errors: resolved.errors, warnings: resolved.warnings };
      }

      const page = await acquire();

      try {
        // Pool wait is not billed to browserRun.
        tracker.reset();
        const run: RunResult = await page.evaluate((payload) => window.__eraser.run(payload), {
          entities: resolved.entities ?? [],
          connections: resolved.connections ?? [],
          icons: resolved.icons ?? {},
        });
        tracker.mark('browserRun');

        const outcome: Record<string, unknown> = {
          ok: true,
          warnings: resolved.warnings,
          timingsMs: tracker.timings,
        };

        if (requested.json) {
          outcome['json'] = toDiagramJson(resolved.authored ?? [], run.layout);
        }

        if (requested.html) {
          embeddedFontCss ??= staged ? buildEmbeddedFontCss(staged) : '';
          const serialized = await page.evaluate(() => window.__eraser.serialize());
          outcome['html'] = buildHtmlDocument({
            title: 'Eraser diagram',
            // Embedded @font-face first, so the role vars that follow resolve against real faces.
            styles: [embeddedFontCss, serialized.css],
            body: serialized.scene,
          });
          tracker.mark('serialize');
        }

        if (requested.png) {
          outcome['png'] = await page.locator('#eraser-scene').screenshot({ type: 'png' });
          tracker.mark('screenshot');
        }

        return outcome;
      } finally {
        release(page);
      }
    }) as Renderer['render'],

    async close(): Promise<void> {
      await context.close();
      await browser.close();
    },
  };
}
