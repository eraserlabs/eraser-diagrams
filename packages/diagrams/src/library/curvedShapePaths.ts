/**
 * Real-size paths for the curved kinds (document, cylinder), scaled from the same 0–100 command
 * strings the static template svg draws. With a real-coordinate path these kinds ride the dynamic
 * geo route: uniform (meet) scaling like the polygon kinds, and a clip target for the watercolor
 * texture stain — the static 0–100 layer stretches non-uniformly and offers neither.
 */

const DOCUMENT_BODY =
  'M 0.87,6.67 C 0.87,3.47 3.41,1 6.53,1 H 93.3 C 96.4,1 99,3.51 99,7 V 77.7 C 98.9,86.3 95.1,89.9 91.3,88.8 C 85.1,87.1 76.1,85.1 68.5,85.1 C 55.4,98.1 44.3,98.1 28,98.1 C 15.2,98.1 5.9,90.8 2.45,87.6 C 0.87,86.7 0.87,85.2 0.87,83.9 V 6.67 Z';
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

export interface CurvedShapePath {
  body: string;
  /** Stroke-only overlay (the cylinder's front rim). */
  cap?: string;
  /** Near-solid wash region at the vessel bottom — pigment pools there instead of fading. */
  washFloor?: string;
}

export function curvedShapePath(kind: string, w: number, h: number): CurvedShapePath | null {
  if (kind === 'document') {
    return { body: scalePath(DOCUMENT_BODY, w, h) };
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
