/**
 * Real-size paths for the curved kinds (document, cylinder). The cylinder scales the same 0–100
 * command strings the static template svg draws; the document follows the Canvas path. With a real-coordinate path these kinds ride the dynamic
 * geo route: uniform (meet) scaling like the polygon kinds, and a clip target for the watercolor
 * texture stain — the static 0–100 layer stretches non-uniformly and offers neither.
 */

const CYLINDER_BODY = 'M 0,11 L 0,89 A 50,11 0 0 0 100,89 L 100,11 A 50,11 0 0 0 0,11';
const CYLINDER_CAP = 'M 0,11 A 50,11 0 0 0 100,11';
// The base dish: the region between the bottom chord and the front bottom arc, grown one rim
// height upward so the watercolor wash can pool into the vessel bottom instead of fading out
// across it (the wash mask keeps this region near-solid while the silhouette fades).
const CYLINDER_FLOOR = 'M 0,78 L 0,89 A 50,11 0 0 0 100,89 L 100,78 A 50,11 0 0 1 0,78';

const COMMAND_RE = /([MLHVCAZ])([^MLHVCAZ]*)/gi;

function numbersOf(args: string): number[] {
  return (args.match(/-?[\d.]+/g) ?? []).map(Number);
}

/** Scale a 0–100 M/L/H/V/C/A/Z path to w×h. Arc radii scale per axis (all arcs are unrotated). */
function scalePath(d: string, w: number, h: number): string {
  const sx = w / 100;
  const sy = h / 100;
  const fmt = (value: number): string => String(Math.round(value * 100) / 100);
  const out: string[] = [];

  for (const [, letter, args] of d.matchAll(COMMAND_RE)) {
    const command = letter!.toUpperCase();
    const values = numbersOf(args ?? '');

    switch (command) {
      case 'M':
      case 'L':
      case 'C': {
        const scaled = values.map((value, i) => fmt(i % 2 === 0 ? value * sx : value * sy));
        out.push(`${command} ${scaled.join(' ')}`);
        break;
      }
      case 'H':
        out.push(`H ${fmt(values[0]! * sx)}`);
        break;
      case 'V':
        out.push(`V ${fmt(values[0]! * sy)}`);
        break;
      case 'A': {
        // rx ry rotation large-arc sweep x y — repeated groups of 7.
        for (let i = 0; i + 6 < values.length; i += 7) {
          out.push(
            `A ${fmt(values[i]! * sx)} ${fmt(values[i + 1]! * sy)} ${values[i + 2]} ${values[i + 3]} ${values[i + 4]} ${fmt(values[i + 5]! * sx)} ${fmt(values[i + 6]! * sy)}`,
          );
        }

        break;
      }
      case 'Z':
        out.push('Z');
        break;
    }
  }

  return out.join(' ');
}

/**
 * The document outline at w×h, as the Canvas draws it (excalidraw `renderer/shapes/pathShape.ts`
 * DocumentShape): each coordinate a share of the width or height, except the top edge, which
 * sits at y = 1px and meets the right side at y = 7px whatever the height.
 */
function documentBody(w: number, h: number): string {
  const fmt = (value: number): string => String(Math.round(value * 100) / 100);
  const x = (share: number): string => fmt(w * share);
  const y = (share: number): string => fmt(h * share);

  return [
    `M ${x(0.0087)} ${y(0.0667)}`,
    `C ${x(0.0087)} ${y(0.0347)} ${x(0.0341)} 1 ${x(0.0653)} 1`,
    `H ${x(0.933)}`,
    `C ${x(0.964)} 1 ${x(0.99)} ${y(0.0351)} ${x(0.99)} 7`,
    `V ${y(0.777)}`,
    `C ${x(0.989)} ${y(0.863)} ${x(0.951)} ${y(0.899)} ${x(0.913)} ${y(0.888)}`,
    `C ${x(0.851)} ${y(0.871)} ${x(0.761)} ${y(0.851)} ${x(0.685)} ${y(0.851)}`,
    `C ${x(0.554)} ${y(0.851)} ${x(0.443)} ${y(0.981)} ${x(0.28)} ${y(0.981)}`,
    `C ${x(0.152)} ${y(0.981)} ${x(0.059)} ${y(0.908)} ${x(0.0245)} ${y(0.876)}`,
    `C ${x(0.0087)} ${y(0.867)} ${x(0.0087)} ${y(0.852)} ${x(0.0087)} ${y(0.839)}`,
    `V ${y(0.066)}`,
    'Z',
  ].join(' ');
}

export interface CurvedShapePath {
  body: string;
  /** Stroke-only overlay (the cylinder's front rim). */
  cap?: string;
  /** Near-solid wash region at the vessel bottom — pigment pools there instead of fading. */
  washFloor?: string;
}

export function curvedShapePath(kind: string, w: number, h: number): CurvedShapePath | null {
  if (kind === 'document') {
    return { body: documentBody(w, h) };
  }

  if (kind === 'cylinder') {
    return {
      body: scalePath(CYLINDER_BODY, w, h),
      cap: scalePath(CYLINDER_CAP, w, h),
      washFloor: scalePath(CYLINDER_FLOOR, w, h),
    };
  }

  return null;
}
