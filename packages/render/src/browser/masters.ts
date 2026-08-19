/**
 * Watercolor master prephase: recolor the library's grayscale wash scan once per distinct
 * pigment pair, before anything mounts — the fonts pattern applied to raster assets. Each tinted
 * master registers ONCE as an SVG `<symbol>` in a shared hidden defs block; elements reference it
 * with `<use href>`, so the page runs zero SVG filters and the serialized artifact carries one
 * copy per color (5-6 for a typical diagram), not one per element.
 *
 * The recolor reproduces the SVG luminance LUT it replaces (feComponentTransfer 3-stop tables +
 * luminance→alpha): dark master regions map toward the shade color, midtones toward the pigment,
 * paper toward white, with alpha = AMPLITUDE * (1 - luminance)^GAMMA so paper drops transparent.
 */

/** Density curve of the recolored stain (the filter's feFuncA gamma exponent). */
const GAMMA = 0.78;
/** Alpha ceiling (the filter's feFuncA gamma amplitude). */
const AMPLITUDE = 0.95;

/** Tinted masters survive across runs on the same page; distinct pairs are few. */
const MAX_CACHE = 128;
const tintCache = new Map<string, { symbolId: string; href: string }>();
let symbolSeq = 0;

/** Grayscale source pixels, decoded once per master data URI. */
let grayFor: string | null = null;
let gray: { data: Uint8ClampedArray; width: number; height: number } | null = null;

interface WashElement {
  props?: Record<string, unknown>;
}

function parseRgb(hex: unknown): [number, number, number] | null {
  if (typeof hex !== 'string') {
    return null;
  }

  const m = /^#([0-9a-f]{6})/i.exec(hex);

  if (!m) {
    return null;
  }

  const v = Number.parseInt(m[1]!, 16);

  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** feComponentTransfer type="table" with 3 stops: piecewise-linear shade → mid → white. */
function stop3(t: number, shade: number, mid: number): number {
  const x = t * 2;

  return x < 1 ? shade + x * (mid - shade) : mid + (x - 1) * (255 - mid);
}

async function decodeMaster(master: string): Promise<typeof gray> {
  if (gray && grayFor === master) {
    return gray;
  }

  const image = new Image();
  image.src = master;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  gray = { data: pixels.data, width: canvas.width, height: canvas.height };
  grayFor = master;

  return gray;
}

function tint(
  source: NonNullable<typeof gray>,
  shade: [number, number, number],
  mid: [number, number, number],
): string {
  // 256-entry LUTs per channel + the alpha curve, then one pass over the pixels.
  const lut = [0, 1, 2].map((channel) =>
    Uint8ClampedArray.from({ length: 256 }, (_, v) =>
      stop3(v / 255, shade[channel]!, mid[channel]!),
    ),
  );
  const alpha = Uint8ClampedArray.from({ length: 256 }, (_, v) =>
    Math.round(255 * Math.min(1, AMPLITUDE * (1 - v / 255) ** GAMMA)),
  );
  const out = new ImageData(source.width, source.height);

  for (let i = 0; i < source.data.length; i += 4) {
    const v = source.data[i]!;
    out.data[i] = lut[0]![v]!;
    out.data[i + 1] = lut[1]![v]!;
    out.data[i + 2] = lut[2]![v]!;
    out.data[i + 3] = alpha[v]!;
  }

  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext('2d')!.putImageData(out, 0, 0);

  // webp keeps alpha and stays small; browsers without webp encode fall back to png themselves.
  return canvas.toDataURL('image/webp', 0.85);
}

/**
 * Stamp `washSym` (the shared symbol reference) on every element carrying a wash pigment pair,
 * tinting each distinct (washShade, washMid) once, and return the `<defs>` markup registering the
 * symbols used by this scene. No-ops (returns '') without a master or wash elements. On tint
 * failure the symbol wraps the grayscale master itself, so the wash still paints (uncolored)
 * rather than vanishing.
 */
export async function prepareWashMasters(
  master: string | undefined,
  elements: readonly WashElement[],
): Promise<string> {
  if (master === undefined || master === '') {
    return '';
  }

  const washes = elements
    .map((element) => element.props)
    .filter(
      (props): props is Record<string, unknown> =>
        props !== undefined && (props.washTexCss === true || props.washTexGeo === true),
    );

  if (washes.length === 0) {
    return '';
  }

  const source = await decodeMaster(master).catch(() => null);
  const used = new Map<string, { symbolId: string; href: string }>();

  for (const props of washes) {
    const shade = parseRgb(props.washShade);
    const mid = parseRgb(props.washMid);
    const key =
      source === null || shade === null || mid === null
        ? 'gray'
        : `${props.washShade}:${props.washMid}`;
    let entry = tintCache.get(key);

    if (entry === undefined) {
      symbolSeq += 1;
      entry = {
        symbolId: `er-wash-${symbolSeq}`,
        href:
          key === 'gray' || source === null || shade === null || mid === null
            ? master
            : tint(source, shade, mid),
      };

      if (tintCache.size >= MAX_CACHE) {
        tintCache.clear();
      }

      tintCache.set(key, entry);
    }

    used.set(key, entry);
    props.washSym = entry.symbolId;
  }

  // slice inside the symbol: any use-site box gets a centered cover-crop of the master.
  const symbols = [...used.values()]
    .map(
      (entry) =>
        `<symbol id="${entry.symbolId}" viewBox="0 0 ${gray?.width ?? 448} ${gray?.height ?? 346}" preserveAspectRatio="xMidYMid slice"><image href="${entry.href}" width="${gray?.width ?? 448}" height="${gray?.height ?? 346}"></image></symbol>`,
    )
    .join('');

  return `<svg aria-hidden="true" style="position:absolute;width:0;height:0"><defs>${symbols}</defs></svg>`;
}
