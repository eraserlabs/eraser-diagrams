/**
 * Import diagram exports into fixtures/corpus.
 *
 *   pnpm fixtures:import <export.json>... [--out fixtures/corpus] [--name <kebab-name>]
 *
 * Accepts an `{ elements }` document or the app's `{ definition: { elements } }` export wrapper.
 * A bare element array is not a document and is refused. Normalizes what the stock library cannot take verbatim — geometry the schema forbids on
 * connections, props the resolver reports as unknown, legacy font-size tokens — then validates.
 * Errors refuse the write; warnings are printed and kept, they are authored content the golden
 * run should see.
 *
 * Prereq: `pnpm build` — imports @eraserlabs/diagrams and @eraserlabs/resolve from dist.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createResolver, type Issue, type Resolver } from '@eraserlabs/resolve';
import { stockLibrary, stockNormalizers } from '@eraserlabs/diagrams';

type Element = Record<string, unknown>;

interface Unwrapped {
  title: string | undefined;
  elements: Element[];
}

const CONNECTION_FORBIDDEN = ['width', 'height', 'containerId'];
const MAX_STRIP_ROUNDS = 5;

/**
 * Older exports carry `fontSize` as `small | medium | large`; the stock library is pixels only.
 * The tokens were multipliers over each text slot's base size (×1.0 / ×1.2 / ×1.4), so `small`
 * equals the default and is dropped, the others become the pixel value the stylesheet would have
 * computed. Base sizes mirror the stock templates (Shape/Icon/Textbox primary 15, secondary run
 * 12, Group title 16).
 */
const LEGACY_FONT_SCALE: Record<string, number> = { small: 1, medium: 1.2, large: 1.4 };
const PRIMARY_TEXT_BASE_PX = 15;
const SECONDARY_TEXT_BASE_PX = 12;
const GROUP_TITLE_BASE_PX = 16;

/** The fixture must lose the key rather than carry `undefined`. */
function removeKey(obj: Element, key: string): boolean {
  const present = key in obj;
  delete obj[key];

  return present;
}

/** Remove the value a resolver issue points at: '/elements/3/textSize' → elements[3].textSize. */
function removeAtPointer(elements: Element[], pointer: string): boolean {
  const parts = pointer.split('/').slice(1);

  if (parts[0] !== 'elements' || parts.length < 3) {
    return false;
  }

  let node: unknown = elements[Number(parts[1])];

  for (const key of parts.slice(2, -1)) {
    if (node === null || typeof node !== 'object') {
      return false;
    }

    node = (node as Element)[key];
  }

  if (node === null || typeof node !== 'object') {
    return false;
  }

  return removeKey(node as Element, parts[parts.length - 1] as string);
}

function unwrap(raw: unknown, fallbackTitle: string): Unwrapped {
  if (Array.isArray(raw)) {
    throw new Error('input is a bare array; wrap it in { "elements": [...] }');
  }

  const doc = raw as {
    title?: string;
    elements?: Element[];
    definition?: { elements?: Element[] };
  };
  const elements = doc.elements ?? doc.definition?.elements;

  if (!elements) {
    throw new Error('no elements found (expected { elements } or { definition: { elements } })');
  }

  return { title: doc.title ?? fallbackTitle, elements };
}

function toKebab(name: string): string {
  return name
    .replace(/\.json$/i, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
}

/** App exports carry float dust (`y: 14.999999999999886`); the document dialect is integer-grid. */
function roundGeometry(elements: Element[]): number {
  let rounded = 0;
  const roundKeys = (obj: Element, keys: readonly string[]): void => {
    for (const key of keys) {
      const value = obj[key];

      if (typeof value === 'number' && Number.isFinite(value) && value !== Math.round(value)) {
        obj[key] = Math.round(value);
        rounded++;
      }
    }
  };

  for (const el of elements) {
    roundKeys(el, ['x', 'y', 'width', 'height']);

    if (Array.isArray(el.points)) {
      for (const point of el.points) {
        if (typeof point === 'object' && point !== null) {
          roundKeys(point as Element, ['x', 'y']);
        }
      }
    }

    if (typeof el.labelPlacement === 'object' && el.labelPlacement !== null) {
      roundKeys(el.labelPlacement as Element, ['x', 'y', 'width', 'height']);
    }
  }

  return rounded;
}

function stripConnectionGeometry(elements: Element[], connectionTags: Set<string>): number {
  let stripped = 0;

  for (const el of elements) {
    if (!connectionTags.has(String(el.tag))) {
      continue;
    }

    for (const key of CONNECTION_FORBIDDEN) {
      if (removeKey(el, key)) {
        stripped++;
      }
    }
  }

  return stripped;
}

function translateFontToken(slot: Element, basePx: number): number {
  if (typeof slot.fontSize !== 'string') {
    return 0;
  }

  const factor = LEGACY_FONT_SCALE[slot.fontSize];

  if (factor === undefined) {
    return 0;
  }

  if (factor === 1) {
    removeKey(slot, 'fontSize');
  } else {
    slot.fontSize = Math.round(basePx * factor);
  }

  return 1;
}

function translateLegacyFontTokens(elements: Element[]): number {
  let translated = 0;

  for (const el of elements) {
    translated += translateFontToken(el, PRIMARY_TEXT_BASE_PX);

    const title = el.title as Element | undefined;
    if (title && typeof title === 'object') {
      translated += translateFontToken(title, GROUP_TITLE_BASE_PX);
    }

    const texts = el.texts as Element[] | undefined;
    if (Array.isArray(texts)) {
      texts.forEach((run, index) => {
        translated += translateFontToken(
          run,
          index === 0 ? PRIMARY_TEXT_BASE_PX : SECONDARY_TEXT_BASE_PX,
        );
      });
    }
  }

  return translated;
}

/** Repeats until quiet: removing one unknown prop can expose another `additionalProperties` hit. */
async function stripUnknownProps(resolver: Resolver, elements: Element[]): Promise<number> {
  let stripped = 0;

  for (let round = 0; round < MAX_STRIP_ROUNDS; round++) {
    const result = await resolver.validate({ elements });
    const unknown = result.warnings.filter((w) => w.code === 'W_UNKNOWN_PROP');

    if (unknown.length === 0) {
      return stripped;
    }

    for (const issue of unknown) {
      if (removeAtPointer(elements, issue.path)) {
        stripped++;
      }
    }
  }

  return stripped;
}

function formatIssue(issue: Issue): string {
  const where = issue.elementId ? `#${issue.elementId}` : issue.path;

  return `  ${issue.severity} ${issue.code} ${where}: ${issue.message}`;
}

async function importOne(
  resolver: Resolver,
  connectionTags: Set<string>,
  file: string,
  outDir: string,
  nameOverride: string | undefined,
): Promise<boolean> {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const name = nameOverride ?? toKebab(basename(file));
  const { title, elements } = unwrap(raw, name);

  const geometryStripped = stripConnectionGeometry(elements, connectionTags);
  const geometryRounded = roundGeometry(elements);
  const fontTokens = translateLegacyFontTokens(elements);
  const unknownStripped = await stripUnknownProps(resolver, elements);
  const result = await resolver.validate({ elements });

  if (!result.ok) {
    console.error(`FAIL  ${file}`);
    for (const issue of [...result.errors, ...result.warnings]) {
      console.error(formatIssue(issue));
    }

    return false;
  }

  for (const warning of result.warnings) {
    console.warn(formatIssue(warning));
  }

  const out = join(outDir, `${name}.json`);
  writeFileSync(out, `${JSON.stringify({ title, elements }, null, 2)}\n`);
  console.info(
    `ok    ${out}  ${elements.length} elements` +
      `  stripped ${geometryStripped} connection geometry, ${unknownStripped} unknown props, rounded ${geometryRounded} coordinates` +
      `  translated ${fontTokens} font tokens`,
  );

  return true;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', default: 'fixtures/corpus' },
      name: { type: 'string' },
    },
  });

  if (positionals.length === 0) {
    console.error('usage: pnpm fixtures:import <export.json>... [--out dir] [--name kebab-name]');
    process.exit(2);
  }

  if (values.name && positionals.length > 1) {
    console.error('--name applies to a single input file');
    process.exit(2);
  }

  const resolver = await createResolver({ library: stockLibrary, normalizers: stockNormalizers });
  const connectionTags = new Set(
    resolver
      .registryInfo()
      .tags.filter((t) => t.kind === 'connection')
      .map((t) => t.tag),
  );
  const outDir = resolve(values.out as string);
  mkdirSync(outDir, { recursive: true });

  let failed = 0;
  for (const file of positionals) {
    const ok = await importOne(resolver, connectionTags, resolve(file), outDir, values.name);
    if (!ok) {
      failed++;
    }
  }

  if (failed > 0) {
    console.error(`${failed} of ${positionals.length} inputs not imported`);
    process.exit(1);
  }
}

await main();
