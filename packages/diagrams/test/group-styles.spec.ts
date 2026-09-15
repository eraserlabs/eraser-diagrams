import { test, expect } from '@playwright/test';
import { buildPayload, runPayload } from './support/payload.js';

for (const tag of ['Group', 'Lane', 'Pool']) {
  test(`${tag}: authored paint, typography, border width and corners`, async ({ page }) => {
    const { payload, result } = await buildPayload({
      entities: [
        {
          tag,
          id: 'g',
          x: 0,
          y: 0,
          width: 300,
          height: 180,
          color: 'blue',
          bgColor: '#ffeecc',
          borderColor: '#cc2244',
          borderWidth: 4,
          cornerRadius: [0, 8, 16, 24],
          styleMode: 'plain',
          title: {
            text: 'Title',
            color: '#228844',
            bgColor: '#ddeeff',
            fontSize: 24,
            typeface: 'mono',
            width: 'full',
            border: true,
            hAlign: 'right',
            icon: 'lucide-server',
            iconProps: { color: '#6622aa', size: 'xl' },
          },
        },
      ],
      connections: [],
    });
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    await runPayload(page, payload);
    const root = page.locator('.er-grouplike');
    await expect(root).toHaveCSS('background-color', 'rgb(255, 238, 204)');
    await expect(root).toHaveCSS('border-top-color', 'rgb(204, 34, 68)');
    await expect(root.locator('header')).toHaveCSS('color', 'rgb(34, 136, 68)');
    await expect(root.locator('header')).toHaveCSS('background-color', 'rgb(221, 238, 255)');
    await expect(root.locator('header')).toHaveCSS('font-size', '24px');
    await expect(root.locator('.er-grouplike__title-icon')).toHaveCSS('color', 'rgb(102, 34, 170)');
    await expect(root.locator('.er-grouplike__title-icon')).toHaveCSS('width', '32px');
    await expect(root).toHaveCSS('border-top-width', '4px');
    await expect(root).toHaveCSS('border-radius', '0px 8px 16px 24px');
  });
}

for (const tag of ['Group', 'Lane', 'Pool']) {
  test(`${tag}: border and title style matrix`, async ({ page }, testInfo) => {
    const entities = [];
    for (const [i, styleMode] of ['plain', 'shadow', 'watercolor'].entries()) {
      for (const [j, borderStyle] of ['solid', 'dashed', 'dotted'].entries()) {
        for (const [k, width] of ['snug', 'full', 'none'].entries()) {
          entities.push({
            tag,
            id: `g${i}${j}${k}`,
            x: j * 280,
            y: (i * 3 + k) * 130,
            width: 250,
            height: 110,
            color: 'blue',
            styleMode,
            borderStyle,
            title: {
              text: `${styleMode} ${borderStyle} ${width}`,
              width,
              color: '#228844',
              border: true,
            },
          });
        }
      }
    }
    const { payload, result } = await buildPayload({ entities, connections: [] });
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    await runPayload(page, payload);
    for (const entity of entities) {
      const root = page.locator(`[data-mdp-id="${entity.id}"] .er-grouplike`);
      const header = root.locator('header');
      await expect(header).toHaveCSS('color', 'rgb(34, 136, 68)');
      const css = await root.evaluate((el) => {
        const body = getComputedStyle(el);
        const overlay = getComputedStyle(el, '::after');
        const title = getComputedStyle(el.querySelector('header')!);
        const stroke = getComputedStyle(el.querySelector('.er-grouplike__stroke')!);
        return {
          shadow: body.boxShadow,
          overlay: overlay.content,
          stroke: stroke.display,
          strokeFilter: stroke.filter,
          background: title.backgroundColor,
          titleBorder: [
            title.borderTopWidth,
            title.borderRightWidth,
            title.borderBottomWidth,
            title.borderLeftWidth,
          ],
        };
      });
      if (entity.borderStyle === 'solid') {
        expect(css.stroke).toBe('none');
        expect(css.shadow === 'none').toBe(entity.styleMode !== 'shadow');
      } else {
        expect(css.stroke).toBe('block');
        expect(css.shadow).toBe('none');
        expect(css.overlay).toBe('none');
        await expect(root.locator(`.er-grouplike__dash--${entity.borderStyle}`)).toHaveCSS(
          'display',
          'block',
        );
        if (entity.styleMode === 'watercolor') {
          expect(css.strokeFilter).toContain('blur');
        }
      }
      if (entity.title.width === 'none') {
        expect(css.background).toBe('rgba(0, 0, 0, 0)');
        expect(css.titleBorder).toEqual(['0px', '0px', '0px', '0px']);
      } else if (entity.title.width === 'snug') {
        expect(css.titleBorder).toEqual(['1px', '1px', '1px', '1px']);
      } else {
        expect(css.titleBorder).toEqual(
          tag === 'Group' ? ['0px', '0px', '1px', '0px'] : ['0px', '1px', '0px', '0px'],
        );
      }
    }
    await testInfo.attach(`${tag}-styles`, {
      body: await page.locator('#eraser-scene').screenshot(),
      contentType: 'image/png',
    });
  });

  test(`${tag}: custom borders, transparency, and title switches`, async ({ page }) => {
    for (const styleMode of ['plain', 'shadow', 'watercolor']) {
      const { payload } = await buildPayload({
        entities: ['solid', 'dashed', 'dotted'].map((borderStyle, i) => ({
          tag,
          id: `g${i}`,
          x: i * 250,
          y: 0,
          width: 220,
          height: 160,
          styleMode,
          borderStyle,
          color: 'blue',
          bgColor: 'transparent',
          borderColor: '#cc2244',
          borderWidth: i === 0 ? 0 : 4,
          cornerRadius: i === 0 ? 'sharp' : i === 1 ? 'round' : [0, 8, 16, 24],
          title: { text: 'Title', width: 'full', border: false, hAlign: 'left' },
        })),
        connections: [],
      });
      await runPayload(page, payload);
      for (let i = 0; i < 3; i++) {
        const root = page.locator(`[data-mdp-id="g${i}"] .er-grouplike`);
        await expect(root).toHaveCSS('border-top-width', i === 0 ? '0px' : '4px');
        await expect(root).toHaveCSS('border-radius', ['0px', '6px', '0px 8px 16px 24px'][i]!);
        await expect(root).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(root).toHaveCSS('box-shadow', 'none');
        await expect(root.locator('.er-grouplike__stroke')).toHaveCSS('display', 'none');
        await expect(root.locator('header')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(root.locator('header')).toHaveCSS('border-right-width', '0px');
        await expect(root.locator('header')).toHaveCSS('border-bottom-width', '0px');
        const overlay = await root.evaluate((el) => {
          const css = getComputedStyle(el, '::after');
          return { width: css.borderTopWidth, style: css.borderTopStyle };
        });
        if (styleMode === 'watercolor') {
          expect(overlay).toEqual({
            width: i === 0 ? '0px' : '4px',
            style: ['solid', 'dashed', 'dotted'][i],
          });
        }
      }
    }
  });

  test(`${tag}: title alignment, typefaces, icon sizes, and badge overrides`, async ({ page }) => {
    const entities = ['snug', 'full', 'none'].flatMap((width, row) =>
      ['left', 'center', 'right'].map((hAlign, col) => ({
        tag,
        id: `g${row}${col}`,
        x: col * 320,
        y: row * 200,
        width: 300,
        height: 180,
        styleMode: 'plain',
        title: {
          text: 'Title',
          width,
          hAlign,
          typeface: ['clean', 'rough', 'mono'][col]!,
          icon: 'lucide-server',
          iconProps: { size: ['sm', 'md', 'lg'][col]! },
        },
        badge: {
          text: '**3**',
          color: '#ff0000',
          bgColor: '#00ff00',
          fontSize: 18,
          padding: 7,
          shape: 'circle',
          placement: 'bottom-left',
        },
      })),
    );
    const { payload } = await buildPayload({ entities, connections: [] });
    // Distinct system faces make inheritance observable without external font loading.
    payload.baseCss +=
      ':root { --font-clean: Arial; --font-rough: Georgia; --font-mono: monospace; }';
    await runPayload(page, payload);
    for (const entity of entities) {
      const root = page.locator(`[data-mdp-id="${entity.id}"] .er-grouplike`);
      await expect(root.locator('.er-grouplike__title-text')).toHaveCSS(
        'font-family',
        { clean: 'Arial', rough: 'Georgia', mono: 'monospace' }[entity.title.typeface]!,
      );
      await expect(root.locator('.er-grouplike__title-icon')).toHaveCSS(
        'width',
        { sm: '12px', md: '15px', lg: '22px' }[entity.title.iconProps.size]!,
      );
      const body = (await root.boundingBox())!;
      const ink = (await root.locator('.er-grouplike__title-text').boundingBox())!;
      const fraction =
        tag === 'Group'
          ? (ink.x + ink.width / 2 - body.x) / body.width
          : 1 - (ink.y + ink.height / 2 - body.y) / body.height;
      if (entity.title.hAlign === 'left') {
        expect(fraction).toBeLessThan(0.35);
      }
      if (entity.title.hAlign === 'right') {
        expect(fraction).toBeGreaterThan(0.65);
      }
      if (entity.title.hAlign === 'center') {
        expect(fraction).toBeGreaterThan(0.4);
      }
      if (entity.title.hAlign === 'center') {
        expect(fraction).toBeLessThan(0.6);
      }
      const badge = root.locator('[data-tpl="Badge"]');
      await expect(badge).toHaveCSS('color', 'rgb(255, 0, 0)');
      await expect(badge).toHaveCSS('background-color', 'rgb(0, 255, 0)');
      await expect(badge).toHaveCSS('padding', '7px');
      await expect(badge).toHaveCSS('font-size', '18px');
      await expect(badge).toHaveCSS('border-radius', '999px');
      expect((await badge.boundingBox())!.y).toBeGreaterThan(body.y + body.height - 30);
    }
  });
}

for (const tag of ['Group', 'Lane', 'Pool']) {
  test(`${tag}: body paint outranks identity in the title surface`, async ({ page }) => {
    for (const styleMode of ['plain', 'shadow', 'watercolor']) {
      for (const bgColor of ['#ffeecc', 'transparent', 'none', '#ffffff']) {
        const { payload } = await buildPayload({
          entities: [false, true].map((identity, i) => ({
            tag,
            id: `g${i}`,
            x: i * 260,
            y: 0,
            width: 240,
            height: 120,
            styleMode,
            ...(identity ? { color: 'blue' } : {}),
            bgColor,
            title: { text: 'Title', width: 'full', border: true },
          })),
          connections: [],
        });
        await runPayload(page, payload);
        const paints = await page
          .locator('.er-grouplike__title')
          .evaluateAll((elements) => elements.map((el) => getComputedStyle(el).backgroundColor));
        expect(paints[1]).toBe(paints[0]);
      }
    }
  });
}

for (const tag of ['Group', 'Lane', 'Pool']) {
  test(`${tag}: watercolor titles preserve plain container geometry`, async ({ page }) => {
    for (const width of ['snug', 'full', 'none']) {
      const sizes = [];
      for (const styleMode of ['plain', 'watercolor']) {
        const { payload } = await buildPayload({
          entities: [
            {
              tag,
              id: 'g',
              x: 0,
              y: 0,
              width: 250,
              height: 110,
              color: 'blue',
              styleMode,
              title: { text: 'Title', width, border: true },
            },
          ],
          connections: [],
        });
        const result = await runPayload(page, payload);
        sizes.push({ body: result.measures[0]!.body, title: result.measures[0]!.parts['title'] });
        if (tag !== 'Group') {
          await expect(page.locator('header')).toHaveCSS('position', 'absolute');
        }
      }
      expect(sizes[1]).toEqual(sizes[0]);
    }
  });
}
