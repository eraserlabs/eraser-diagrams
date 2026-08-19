import { describe, it, expect, beforeAll } from 'vitest';
import type { Resolver } from '@eraserlabs/resolve';
import { allElements, buildTestResolver } from './helper.js';
import { STOCK_PALETTE, STOCK_PALETTE_TOKENS } from '../src/library/index.js';

let resolver: Resolver;
beforeAll(async () => {
  resolver = await buildTestResolver();
});

async function resolveProps(element: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await resolver.resolve({ elements: [element] });
  expect(r.ok, JSON.stringify(r.errors)).toBe(true);

  return allElements(r)[0]!.props;
}

describe('x-palette translation — one identity value, no derived pair', () => {
  it('Shape: a palette token becomes its palette color, in place, on `color` alone', async () => {
    const props = await resolveProps({ tag: 'Shape', id: 's', x: 0, y: 0, color: 'blue' });
    expect(props.color).toBe('#2866c4');
    // The pastel body, the hairline and the badge tint are CSS formulas over that one value now.
    expect(props.fillColor).toBeUndefined();
    expect(props.borderColor).toBeUndefined();
  });

  it('a raw CSS color passes through, and now gets the identity treatment tokens used to get', async () => {
    const props = await resolveProps({ tag: 'Shape', id: 's', x: 0, y: 0, color: 'peachpuff' });
    expect(props.color).toBe('peachpuff');
  });

  it('a string that is neither errors, with a did-you-mean over the token names', async () => {
    const r = await resolver.resolve({
      elements: [{ tag: 'Shape', id: 's', x: 0, y: 0, color: 'blu' }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe('E_INVALID_COLOR');
    expect(r.errors[0]?.path).toBe('/elements/0/color');
    expect(r.errors[0]?.message).toContain('neither a palette token nor a CSS color');
    expect(r.errors[0]?.suggestion).toBe('blue');
  });

  it('bgColor / borderColor are raw CSS only — a token name is not a color', async () => {
    const raw = await resolveProps({ tag: 'Shape', id: 's', x: 0, y: 0, bgColor: '#123456' });
    expect(raw.bgColor).toBe('#123456');

    // "red" and "yellow" are CSS named colors too, so they stay themselves rather than
    // resolving to the palette identity they used to alias.
    const named = await resolveProps({
      tag: 'Shape',
      id: 's2',
      x: 0,
      y: 0,
      bgColor: 'red',
      borderColor: 'yellow',
    });
    expect(named.bgColor).toBe('red');
    expect(named.borderColor).toBe('yellow');
  });

  it('Shape: absent shape, styleMode, and vAlign come from the schema', async () => {
    const props = await resolveProps({ tag: 'Shape', id: 's', x: 0, y: 0 });
    expect(props.shape).toBe('rectangle');
    expect(props.styleMode).toBe('shadow');
    expect(props.vAlign).toBe('middle');
  });

  it("Group: the same one value; the near-white tint is the stylesheet's step, not a prop", async () => {
    const props = await resolveProps({ tag: 'Group', id: 'g', x: 0, y: 0, color: 'blue' });
    expect(props.color).toBe('#2866c4');
    expect(props.fillColor).toBeUndefined();
    expect(props.fillMode).toBeUndefined();
  });

  it('Badge: a nested bgColor is raw paint — no palette lookup, no defaults', async () => {
    const props = await resolveProps({
      tag: 'Shape',
      id: 's',
      x: 0,
      y: 0,
      badge: { text: '3', bgColor: '#2866c4' },
    });
    const badge = props.badge as Record<string, unknown>;
    expect(badge.bgColor).toBe('#2866c4');
    expect(badge.color).toBeUndefined();
    expect(badge.padding).toBeUndefined();
  });

  it('Relationship: the stroke site translates the token in place', async () => {
    const r = await resolver.resolve({
      elements: [
        { tag: 'Shape', id: 'a', x: 0, y: 0 },
        { tag: 'Relationship', id: 'r', from: 'a', to: 'a', color: 'green' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(allElements(r)[1]!.props.color).toBe('#30a050');
  });

  it('Relationship: absent endArrowhead is triangle; explicit null is kept', async () => {
    const filled = await resolver.resolve({
      elements: [
        { tag: 'Shape', id: 'a', x: 0, y: 0 },
        { tag: 'Relationship', id: 'r', from: 'a', to: 'a' },
      ],
    });
    expect(filled.ok).toBe(true);
    expect(allElements(filled)[1]!.props.endArrowhead).toBe('triangle');
    expect(filled.authored!.find((row) => row.kind === 'connection')!.source).not.toHaveProperty(
      'endArrowhead',
    );

    const optedOut = await resolver.resolve({
      elements: [
        { tag: 'Shape', id: 'a', x: 0, y: 0 },
        { tag: 'Relationship', id: 'r', from: 'a', to: 'a', endArrowhead: null },
      ],
    });
    expect(optedOut.ok).toBe(true);
    expect(allElements(optedOut)[1]!.props.endArrowhead).toBeNull();
  });

  it('Group: absent styleMode is shadow', async () => {
    const props = await resolveProps({ tag: 'Group', id: 'g', x: 0, y: 0 });
    expect(props.styleMode).toBe('shadow');
  });

  it('every stock token translates to one concrete color', async () => {
    for (const token of STOCK_PALETTE_TOKENS) {
      const props = await resolveProps({ tag: 'Shape', id: token, x: 0, y: 0, color: token });
      expect(props.color).toBe(STOCK_PALETTE[token]);
    }
  });
});

describe('group title band — nothing left to derive', () => {
  it('the band keeps its authored shape: no titleStyle/titleRule/titleBgColor props', async () => {
    const full = await resolveProps({
      tag: 'Group',
      id: 'g',
      x: 0,
      y: 0,
      title: { text: 'Cluster', width: 'full' },
    });
    expect(full.titleStyle).toBeUndefined();
    expect(full.titleRule).toBeUndefined();
    expect((full.title as { width: string; border: boolean }).width).toBe('full');
    expect((full.title as { width: string; border: boolean }).border).toBe(true);

    const chip = await resolveProps({
      tag: 'Group',
      id: 'g2',
      x: 0,
      y: 0,
      title: {
        text: 'T',
        bgColor: '#eeeeee',
        hAlign: 'center',
        icon: 'lucide-server',
        iconProps: { size: 'lg', color: '#123456' },
      },
    });
    expect(chip.titleBgColor).toBeUndefined();
    expect(chip.titleHAlign).toBeUndefined();
    expect(chip.titleIconColor).toBeUndefined();
    const title = chip.title as {
      bgColor: string;
      hAlign: string;
      border: boolean;
      width: string;
      iconProps: Record<string, string>;
    };
    expect(title.bgColor).toBe('#eeeeee');
    expect(title.hAlign).toBe('center');
    expect(title.border).toBe(true);
    expect(title.width).toBe('snug');
    expect(title.iconProps.color).toBe('#123456');
    // The icon-size token stays a token: Group.style.css maps it to 22px in the title band.
    expect(title.iconProps.size).toBe('lg');
  });

  it('schema defaults the stock chip; width none and border false are explicit opt-outs', async () => {
    const bare = await resolveProps({
      tag: 'Group',
      id: 'g',
      x: 0,
      y: 0,
      title: { text: 'Bare' },
    });
    expect(bare.title).toMatchObject({ text: 'Bare', border: true, width: 'snug' });

    const transparent = await resolveProps({
      tag: 'Group',
      id: 'g2',
      x: 0,
      y: 0,
      title: { text: 'Plain', width: 'none' },
    });
    expect(transparent.title).toMatchObject({ text: 'Plain', width: 'none', border: true });

    const unfilledBand = await resolveProps({
      tag: 'Lane',
      id: 'l',
      x: 0,
      y: 0,
      title: { text: 'Band', border: false, width: 'full' },
    });
    expect(unfilledBand.title).toMatchObject({ text: 'Band', border: false, width: 'full' });

    const untitled = await resolveProps({ tag: 'Pool', id: 'p', x: 0, y: 0 });
    expect(untitled.title).toBeUndefined();
  });
});

describe('derive stage — text sizing vocabulary', () => {
  it('fontSize reaches the payload untouched — resolution computes no px', async () => {
    const pixels = await resolveProps({
      tag: 'Textbox',
      id: 't',
      x: 0,
      y: 0,
      text: 'x',
      fontSize: 20,
    });
    expect(pixels.fontSize).toBe(20);
    expect(pixels.fontPx).toBeUndefined();

    // An unsized slot carries nothing at all: its default is --er-base in the stylesheet.
    const bare = await resolveProps({ tag: 'Textbox', id: 't2', x: 0, y: 0, text: 'x' });
    expect(bare.fontSize).toBeUndefined();
    expect(bare.fontPx).toBeUndefined();
  });

  it('sizes are pixels only: no enum arm survives on any slot', async () => {
    const element = await resolver.resolve({
      elements: [{ tag: 'Textbox', id: 't', x: 0, y: 0, text: 'x', fontSize: 'md' }],
    });
    expect(element.ok).toBe(false);
    expect(element.errors[0]?.code).toBe('E_SCHEMA');
    expect(element.errors[0]?.message).toContain('/0/fontSize');

    const run = await resolver.resolve({
      elements: [{ tag: 'Shape', id: 's', x: 0, y: 0, texts: [{ text: 'a', fontSize: 'lg' }] }],
    });
    expect(run.ok).toBe(false);
    expect(run.errors[0]?.message).toContain('/0/texts/0/fontSize');
  });

  it('a stray fontScale or textSize is an ignored-unknown-prop warning pointing at fontSize', async () => {
    const r = await resolver.resolve({
      elements: [
        { tag: 'Shape', id: 'a', x: 0, y: 0, fontScale: 'md' },
        { tag: 'Relationship', id: 'r', from: 'a', to: 'a', label: 'x', textSize: 'md' },
      ],
    });
    expect(r.ok).toBe(true);
    const warnings = r.warnings.filter((w) => w.code === 'W_UNKNOWN_PROP');
    expect(warnings.map((w) => [w.message, w.suggestion])).toEqual([
      ['Unknown property "fontScale" was ignored.', 'fontSize'],
      ['Unknown property "textSize" was ignored.', 'fontSize'],
    ]);
  });

  it('a forbidden property still names itself: the kind exclusions keep the `not` message', async () => {
    const r = await resolver.resolve({
      elements: [{ tag: 'Textbox', id: 't', x: 0, y: 0, text: 'x', from: 'other' }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe('E_SCHEMA');
    expect(r.errors[0]?.message).toBe(
      'Property "from" is not allowed on tag "Textbox" at /elements/0.',
    );
  });
});

describe('derive stage — sizing', () => {
  it('Shape texts keep authored typeface; the element has none', async () => {
    const props = await resolveProps({
      tag: 'Shape',
      id: 's',
      x: 0,
      y: 0,
      fontSize: 21,
      icon: 'lucide-server',
      iconProps: { size: 'lg', color: '#123456' },
      texts: [
        { text: 'label' },
        { text: 'sub' },
        { text: 'pinned', fontSize: 20, typeface: 'clean' },
      ],
    });
    const runs = props.texts as { fontSize?: number; typeface?: string }[];
    expect(props.typeface).toBeUndefined();
    expect(runs[0]!.typeface).toBeUndefined();
    expect(runs[1]!.typeface).toBeUndefined();
    expect(runs[2]!.typeface).toBe('clean');
    expect(runs[2]!.fontSize).toBe(20);
    expect(props.iconColor).toBe('#123456');
    expect(props.fontSize).toBe(21);
  });

  it('Shape: authored vAlign wins; vMargin is clamped non-negative', async () => {
    const defaults = await resolveProps({ tag: 'Shape', id: 's1', x: 0, y: 0 });
    const clamped = await resolveProps({
      tag: 'Shape',
      id: 's2',
      x: 0,
      y: 0,
      vAlign: 'top',
      vMargin: -12,
    });

    expect(defaults.vAlign).toBe('middle');
    expect(defaults.vMargin).toBe(10);
    expect(clamped.vAlign).toBe('top');
    expect(clamped.vMargin).toBe(0);
  });

  it('Textbox: a fixed-width box still gets a wrappable formatting context', async () => {
    const props = await resolveProps({
      tag: 'Textbox',
      id: 't',
      x: 0,
      y: 0,
      text: 'x',
      fontSize: 20,
      fixedWidth: true,
    });
    expect(props.wrapMode).toBe('wrap');
  });

  it('Textbox: without fixedWidth still accepts the renderer fallback width', async () => {
    const props = await resolveProps({ tag: 'Textbox', id: 't', x: 0, y: 0, text: 'x' });
    expect(props.wrapMode).toBe('wrap');
  });

  it("Icon: the size token stays a token — px is the stylesheet's job", async () => {
    const preset = await resolveProps({ tag: 'Icon', id: 'i', x: 0, y: 0, size: 'md' });
    expect(preset.size).toBe('md');
    expect(preset.sizePx).toBeUndefined();
    const numeric = await resolver.resolve({
      elements: [{ tag: 'Icon', id: 'i', x: 0, y: 0, size: 64 }],
    });
    expect(numeric.ok).toBe(false);
    expect(numeric.errors[0]?.message).toContain('must be string');
  });

  it('the same size token stays a token per host: shape child and group title', async () => {
    const shape = await resolveProps({
      tag: 'Shape',
      id: 's',
      x: 0,
      y: 0,
      icon: 'lucide-server',
      iconProps: { size: 'md' },
    });
    const group = await resolveProps({
      tag: 'Group',
      id: 'g',
      x: 0,
      y: 0,
      title: { text: 'T', icon: 'lucide-server', iconProps: { size: 'md' } },
    });

    expect((shape.iconProps as { size: string }).size).toBe('md');
    expect((group.title as { iconProps: { size: string } }).iconProps.size).toBe('md');
  });

  it('Icon: sizePx is derived only from authored bounds, which outrank the token', async () => {
    const bounds = await resolveProps({ tag: 'Icon', id: 'i', x: 0, y: 0, width: 40, height: 60 });
    expect(bounds.sizePx).toBe(40);
    const heightOnly = await resolveProps({ tag: 'Icon', id: 'i', x: 0, y: 0, height: 60 });
    expect(heightOnly.sizePx).toBe(60);
    const conflict = await resolveProps({
      tag: 'Icon',
      id: 'i',
      x: 0,
      y: 0,
      size: 'sm',
      width: 50,
    });
    expect(conflict.sizePx).toBe(50);
    // No bounds = no derived px; the token (or the 50px root default) wins in CSS.
    const bare = await resolveProps({ tag: 'Icon', id: 'i', x: 0, y: 0 });
    expect(bare.sizePx).toBeUndefined();
  });
});

describe('derive stage — validation of derived output', () => {
  it('a normalizer emitting an invalid color is caught by the color stage', async () => {
    const custom = await buildTestResolver({
      normalizers: {
        Shape: (element) => {
          element.iconColor = 'not-a-color;url(evil)';
        },
      },
    });
    const r = await custom.resolve({ elements: [{ tag: 'Shape', id: 's', x: 0, y: 0 }] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'E_INVALID_COLOR')).toBe(true);
  });

  it('an x-palette prop keeps the same safety net after the normalizers run', async () => {
    const custom = await buildTestResolver({
      normalizers: {
        Shape: (element) => {
          element.color = 'not-a-color;url(evil)';
        },
      },
    });
    const r = await custom.resolve({ elements: [{ tag: 'Shape', id: 's', x: 0, y: 0 }] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'E_INVALID_COLOR')).toBe(true);
  });
});

describe('derive stage — watercolor', () => {
  it('texture stain replaces the flat fill for hex pigments on CSS geometry', async () => {
    const props = await resolveProps({
      tag: 'Shape',
      id: 'w1',
      x: 0,
      y: 0,
      width: 160,
      height: 80,
      styleMode: 'watercolor',
      color: 'blue',
    });

    // The body IS the recolored master; the stylesheet drops the paint behind it, no blob mounts.
    expect(props.fillColor).toBeUndefined();
    expect(props.washTexCss).toBe(true);
    expect(props.washPath).toBeUndefined();
    expect(props.washUid).toBe('w1');
    // The pigment pair the browser prephase tints the master with: shade = palette border.
    expect(props.washMid).toMatch(/^#[0-9a-f]{6}$/);
    expect(props.washShade).toMatch(/^#[0-9a-f]{6}$/);
    expect(props.washShade).not.toBe(props.washMid);
  });

  it('texture stain clips to the dynamic geometry for polygon kinds', async () => {
    const props = await resolveProps({
      tag: 'Shape',
      id: 'w1g',
      x: 0,
      y: 0,
      width: 160,
      height: 80,
      shape: 'hexagon',
      styleMode: 'watercolor',
      color: 'blue',
    });

    expect(props.washTexGeo).toBe(true);
    expect(props.washTexCss).toBeUndefined();
    expect(props.geoPath).toMatch(/^M/);
    expect(props.washPath).toBeUndefined();
  });

  it('a white body washes as barely-there gray (white cannot tint the master)', async () => {
    const props = await resolveProps({
      tag: 'Shape',
      id: 'w2',
      x: 0,
      y: 0,
      styleMode: 'watercolor',
      bgColor: '#ffffff',
    });

    expect(props.washTexCss).toBe(true);
    expect(props.washMid).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('an unpainted body gets no wash at all', async () => {
    const bare = await resolveProps({
      tag: 'Shape',
      id: 'w3',
      x: 0,
      y: 0,
      styleMode: 'watercolor',
    });
    expect(bare.washPath).toBeUndefined();

    const explicit = await resolveProps({
      tag: 'Shape',
      id: 'w3b',
      x: 0,
      y: 0,
      styleMode: 'watercolor',
      bgColor: 'transparent',
    });
    expect(explicit.washPath).toBeUndefined();
  });

  it.each([
    ['rgb()', 'rgb(120, 140, 220)'],
    ['a named color', 'cornflowerblue'],
  ])('%s converts to a hex pigment and takes the texture', async (_, bgColor) => {
    const props = await resolveProps({
      tag: 'Shape',
      id: 'a',
      x: 0,
      y: 0,
      styleMode: 'watercolor',
      bgColor,
    });

    expect(props.washTexCss).toBe(true);
    expect(props.washMid).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('document and cylinder derive real-size curves and take the texture stain', async () => {
    const doc = await resolveProps({
      tag: 'Shape',
      id: 'w5',
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      shape: 'document',
      styleMode: 'watercolor',
      color: 'blue',
    });
    expect(doc.washTexGeo).toBe(true);
    expect(doc.washPath).toBeUndefined();
    expect(doc.geoPath).toMatch(/^M .*C /);

    const cyl = await resolveProps({
      tag: 'Shape',
      id: 'w6',
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      shape: 'cylinder',
      styleMode: 'watercolor',
      color: 'green',
    });
    expect(cyl.washTexGeo).toBe(true);
    expect(cyl.geoPath).toMatch(/A /);
    expect(cyl.geoCapPath).toMatch(/^M .*A /);
  });

  it('other style modes derive no wash props', async () => {
    const props = await resolveProps({
      tag: 'Shape',
      id: 'w4',
      x: 0,
      y: 0,
      styleMode: 'shadow',
      color: 'blue',
    });

    expect(props.washPath).toBeUndefined();
    expect(props.washTexCss).toBeUndefined();
  });
});

describe('derive stage — rounded polygon geometry', () => {
  it('author-sized polygon kinds derive a real-size rounded path', async () => {
    const props = await resolveProps({
      tag: 'Shape',
      id: 'g1',
      x: 0,
      y: 0,
      width: 140,
      height: 100,
      shape: 'hexagon',
    });

    expect(props.staticGeo).toBeUndefined();
    expect(props.geoW).toBe(140);
    expect(props.geoH).toBe(100);
    // One L + A pair per vertex, closed.
    expect(props.geoPath).toMatch(/^M[\d.\- ]+A/);
    expect(String(props.geoPath).match(/A/g)).toHaveLength(6);
    expect(props.geoPath).toMatch(/Z$/);
  });

  it('auto-sized polygons and non-polygon kinds fall back to the static geometry', async () => {
    const auto = await resolveProps({ tag: 'Shape', id: 'g2', x: 0, y: 0, shape: 'hexagon' });
    expect(auto.geoPath).toBeUndefined();
    expect(auto.staticGeo).toBe(true);

    const rect = await resolveProps({
      tag: 'Shape',
      id: 'g3',
      x: 0,
      y: 0,
      width: 100,
      height: 60,
    });
    expect(rect.geoPath).toBeUndefined();
    expect(rect.staticGeo).toBe(true);
  });

  it('the corner radius clamps to what short edges allow', async () => {
    // A tiny star: 6px radius cannot fit its spikes; arcs shrink instead of overlapping.
    const props = await resolveProps({
      tag: 'Shape',
      id: 'g4',
      x: 0,
      y: 0,
      width: 20,
      height: 20,
      shape: 'star',
    });

    const radii = [...String(props.geoPath).matchAll(/A([\d.]+) /g)].map((m) => Number(m[1]));
    expect(radii).toHaveLength(10);

    for (const r of radii) {
      expect(r).toBeLessThanOrEqual(6);
      expect(r).toBeGreaterThan(0);
    }

    expect(radii.some((r) => r < 6)).toBe(true);
  });
});
