import { test, expect, type Page } from '@playwright/test';
import { buildPayload, readFixture, runPayload } from './support/payload.js';

/**
 * The canvas fidelity rules for badges, arrowheads and connection labels, asserted on computed
 * styles and boxes (the picture itself is the `badge-fidelity` golden):
 *
 * - a badge paints from its host: background = the body at 98% lightness (the page ground when
 *   the body is transparent), text = the host's text colour, border = the host's stroke (colour,
 *   width, style); authored `badge.bgColor` / `badge.color` still win;
 * - the top-left badge sits on the outline per shape (the canvas getIconBadgePosition offsets);
 * - `top`, `right`, `bottom`, `left` sit on the middle of that edge;
 * - `arrow` is a fixed 12px head at every line width, `triangle` grows with the line;
 * - a label follows the line colour unless `labelColor` is authored.
 */

async function render(page: Page) {
  const { payload, result } = await buildPayload(readFixture('badge-fidelity'));
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  await runPayload(page, payload);
}

const badge = (page: Page, id: string) => page.locator(`[data-mdp-id="${id}"] [data-tpl="Badge"]`);

/** `rgb(r, g, b)` or `color(srgb r g b)` (what color-mix computes to) as 0–255 channels. */
function channels(css: string): number[] {
  const m = css.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/);
  if (m) {
    return m.slice(1, 4).map((v) => Math.round(Number(v) * 255));
  }

  return (css.match(/\d+/g) ?? []).slice(0, 3).map(Number);
}

/** A CSS colour as the browser computes it for `color`, in channels. */
async function computed(page: Page, css: string): Promise<number[]> {
  return channels(
    await page.evaluate((c) => {
      const probe = document.createElement('span');
      probe.style.color = c;
      document.body.append(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      return rgb;
    }, css),
  );
}

/** The badge's box relative to its host's box, in CSS px. */
async function badgeOffset(page: Page, id: string) {
  return page.evaluate((hostId) => {
    const host = document.querySelector(`[data-mdp-id="${hostId}"]`)!;
    const chip = host.querySelector('[data-tpl="Badge"]')!;
    const h = host.getBoundingClientRect();
    const b = chip.getBoundingClientRect();

    return {
      left: b.left - h.left,
      right: h.right - b.right,
      top: b.top - h.top,
      bottom: h.bottom - b.bottom,
      cx: b.left + b.width / 2 - h.left,
      cy: b.top + b.height / 2 - h.top,
      width: b.width,
      height: b.height,
      host: { width: h.width, height: h.height },
    };
  }, id);
}

test('badge paint follows the host: tint, ink and stroke; authored paint wins', async ({
  page,
}) => {
  await render(page);

  // No colour on the host: the ground (white when the embedder sets no --er-ground), the
  // inherited text colour and the default hairline.
  const plain = badge(page, 'paint-plain');
  await expect(plain).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(plain).toHaveCSS('color', 'rgb(36, 36, 36)');
  expect(channels(await plain.evaluate((el) => getComputedStyle(el).borderTopColor))).toEqual([
    36, 36, 36,
  ]);

  // An identity colour: the badge is a tint of it (not white) and its border is the identity.
  const tinted = badge(page, 'paint-color');
  const tintBg = await tinted.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(tintBg).not.toBe('rgb(255, 255, 255)');
  const hostStroke = await page
    .locator('[data-mdp-id="paint-color"] [data-tpl="Shape"]')
    .evaluate((el) => getComputedStyle(el).getPropertyValue('--er-stroke').trim());
  const badgeBorder = channels(await tinted.evaluate((el) => getComputedStyle(el).borderTopColor));
  const stroke = await computed(page, hostStroke);
  badgeBorder.forEach((v, i) => expect(Math.abs(v - stroke[i]!)).toBeLessThanOrEqual(1));

  // A dark body with light text: the badge takes the light text colour and the body's hue at
  // 98% lightness (the canvas getColorAtLightScale(bg, 1)), so it follows the host's colour.
  const dark = badge(page, 'paint-dark');
  await expect(dark).toHaveCSS('color', 'rgb(232, 238, 252)');
  const [r, g, b] = channels(await dark.evaluate((el) => getComputedStyle(el).backgroundColor));
  expect(r! + g! + b!).toBeGreaterThan(3 * 240); // near white
  expect(b!).toBeGreaterThan(r!); // but still the body's blue hue, not pure white
  // The border is the host's stroke: colour, hairline width and style. (Chromium snaps a CSS
  // border to whole device px, so the 1.2px hairline reads back as 1px at DPR 1; the published
  // token is what the badge follows.)
  expect(
    await dark.evaluate((el) => getComputedStyle(el).getPropertyValue('--er-host-border-width')),
  ).toMatch(/1\.2px/);
  expect(channels(await dark.evaluate((el) => getComputedStyle(el).borderTopColor))).toEqual([
    143, 179, 255,
  ]);
  const dashed = badge(page, 'paint-dashed');
  await expect(dashed).toHaveCSS('border-top-style', 'dashed');

  // Authored badge paint outranks the derived defaults.
  const authored = badge(page, 'paint-authored');
  await expect(authored).toHaveCSS('background-color', 'rgb(189, 65, 58)');
  await expect(authored).toHaveCSS('color', 'rgb(255, 255, 255)');

  // A group publishes the same tokens: its badge takes the title's colour as ink.
  await expect(badge(page, 'paint-group')).toHaveCSS('color', 'rgb(122, 31, 31)');
});

test('the top-left badge sits on the outline per shape', async ({ page }) => {
  await render(page);

  // getIconBadgePosition on a 160 x 90 host: the top-left of a 24px square the badge is centred
  // on, so the badge's left edge = x and its vertical centre = y + 12. Every shape with its own
  // rule is listed, so a `data-shape` token that stops matching fails here, not in a golden.
  const W = 160;
  const H = 90;
  const expected: Record<string, { left: number; cy: number }> = {
    rectangle: { left: 12, cy: 0 },
    cylinder: { left: 12, cy: 0 },
    document: { left: 12, cy: 0 },
    ellipse: { left: 30, cy: 0.05 * H },
    hexagon: { left: 0.15 * W, cy: 0.05 * H + 12 },
    diamond: { left: 0.215 * W, cy: 0.1 * H + 12 },
    parallelogram: { left: 0.3 * W, cy: 0 },
    trapezoid: { left: 0.3 * W, cy: 0 },
    oval: { left: 0.1 * W, cy: 0 },
    triangle: { left: 0.25 * W, cy: 0.15 * H + 12 },
    circle: { left: 0.015 * W, cy: 0.085 * H + 12 },
    star: { left: 0.15 * W, cy: 0.25 * H + 12 },
  };

  for (const [shape, at] of Object.entries(expected)) {
    const got = await badgeOffset(page, `tl-${shape}`);
    expect(got.host, shape).toEqual({ width: W, height: H });
    expect(got.left, `${shape} left`).toBeCloseTo(at.left, 0);
    expect(got.cy, `${shape} centre y`).toBeCloseTo(at.cy, 0);
  }
});

test('top, right, bottom and left badges sit on the middle of their edge', async ({ page }) => {
  await render(page);

  const top = await badgeOffset(page, 'pl-top');
  expect(top.cx).toBeCloseTo(top.host.width / 2, 0);
  expect(top.cy).toBeCloseTo(0, 0);

  const bottom = await badgeOffset(page, 'pl-bottom');
  expect(bottom.cx).toBeCloseTo(bottom.host.width / 2, 0);
  expect(bottom.cy).toBeCloseTo(bottom.host.height, 0);

  const left = await badgeOffset(page, 'pl-left');
  expect(left.cx).toBeCloseTo(0, 0);
  expect(left.cy).toBeCloseTo(left.host.height / 2, 0);

  const right = await badgeOffset(page, 'pl-right');
  expect(right.cx).toBeCloseTo(right.host.width, 0);
  expect(right.cy).toBeCloseTo(right.host.height / 2, 0);
});

test('arrow heads stay 12px at every line width; triangle heads scale with it', async ({
  page,
}) => {
  await render(page);

  const marker = (id: string, name: string) =>
    page.locator(`[data-mdp-id="${id}"] marker#er-ah-${name}`);

  await expect(marker('r-arrow-1', 'arrow')).toHaveAttribute('markerUnits', 'userSpaceOnUse');
  await expect(marker('r-arrow-1', 'arrow')).toHaveAttribute('markerWidth', '12');
  // The chevron is stroked with the line's own width, not a marker-unit constant.
  for (const [id, px] of [
    ['r-arrow-1', 1.75],
    ['r-arrow-4', 7],
  ] as const) {
    const sw = await page
      .locator(`[data-mdp-id="${id}"] marker#er-ah-arrow path`)
      .evaluate((el) => parseFloat(getComputedStyle(el).strokeWidth));
    expect(sw).toBeCloseTo(px, 2);
  }

  // triangle: 10 x lineWidth long = 5.71 stroke widths at 1.75px per lineWidth.
  await expect(marker('r-tri-1', 'triangle')).toHaveAttribute('markerUnits', 'strokeWidth');
  await expect(marker('r-tri-1', 'triangle')).toHaveAttribute('markerWidth', '5.71');
});

test('a label follows the line colour unless labelColor is authored', async ({ page }) => {
  await render(page);

  const label = (id: string) => page.locator(`[data-mdp-id="${id}"] .er-rel__label`);

  await expect(label('lab-inherit')).toHaveCSS('color', 'rgb(192, 57, 43)');
  await expect(label('lab-own')).toHaveCSS('color', 'rgb(31, 111, 235)');

  // The same rule on an ERD line (labelColor lives on the shared connection base).
  const dbLabel = (id: string) => page.locator(`[data-mdp-id="${id}"] .er-dbrel__label`);
  await expect(dbLabel('erd-inherit')).toHaveCSS('color', 'rgb(192, 57, 43)');
  await expect(dbLabel('erd-own')).toHaveCSS('color', 'rgb(31, 111, 235)');
});

test('an arrow head is not clipped by its marker at a thick line width', async ({ page }) => {
  await render(page);

  // The chevron overflows its 12 x 11 viewport by half the stroke on every side.
  await expect(page.locator('[data-mdp-id="r-arrow-4"] marker#er-ah-arrow')).toHaveAttribute(
    'overflow',
    'visible',
  );
});
