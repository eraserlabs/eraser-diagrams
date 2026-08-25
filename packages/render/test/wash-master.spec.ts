import { expect, test } from '@playwright/test';
import {
  BASE_CSS,
  TEMPLATES,
  openScene,
  splitScene,
  type SceneElement,
} from './support/harness.js';

/**
 * Wash master decoding must never depend on `Image.decode()` settling: Chrome parks those
 * promises until the page first composites, so on pages that never do (background tabs, hidden
 * embeds) a bare `await image.decode()` hangs `run()` forever with no error. Both tests park
 * every decode promise via an init script to reproduce that environment.
 */

const WASH_SCENE: SceneElement[] = [
  {
    tag: 'Card',
    id: 'washed',
    x: 0,
    y: 0,
    props: { label: 'w', kind: 'k', washTexCss: true, washShade: '#334455', washMid: '#88aacc' },
  },
];

function parkDecode(): void {
  Image.prototype.decode = () => new Promise(() => {});
}

test('a wash scene completes on pages where Image.decode() never settles', async ({ page }) => {
  await page.addInitScript(parkDecode);
  await openScene(page);

  const outcome = await page.evaluate(
    async ({ templates, baseCss, request }) => {
      // An 8×8 gray ramp PNG built in-page stands in for the library's grayscale scan.
      const canvas = document.createElement('canvas');
      canvas.width = 8;
      canvas.height = 8;
      const context = canvas.getContext('2d')!;
      const ramp = context.createLinearGradient(0, 0, 8, 8);
      ramp.addColorStop(0, '#000000');
      ramp.addColorStop(1, '#ffffff');
      context.fillStyle = ramp;
      context.fillRect(0, 0, 8, 8);
      const master = canvas.toDataURL('image/png');

      window.__eraser.setup({ templates, baseCss, washMaster: master });
      const result = await window.__eraser.run(request);
      const symbol = document.querySelector('symbol[id^="er-wash-"]');

      return {
        washedBox: result.layout.boxes['washed'],
        washSym: request.entities[0]!.props.washSym,
        symbolId: symbol?.id ?? null,
        symbolHref: symbol?.querySelector('image')?.getAttribute('href') ?? null,
        masterHref: master,
      };
    },
    {
      templates: Object.fromEntries(
        Object.entries(TEMPLATES).map(([name, { html, css }]) => [name, { html, css }]),
      ),
      baseCss: BASE_CSS,
      request: { ...splitScene(WASH_SCENE), icons: {} },
    },
  );

  // The pipeline finished (a hang fails the test by timeout) and the element got its symbol.
  expect(outcome.washedBox).toEqual({ x: 0, y: 0, width: 110, height: 30 });
  expect(outcome.washSym).toMatch(/^er-wash-/);
  expect(outcome.symbolId).toBe(outcome.washSym);

  // A tinted href (not the grayscale master itself) proves the pixels really decoded rather
  // than falling through the catch to the uncolored fallback.
  expect(outcome.symbolHref).not.toBeNull();
  expect(outcome.symbolHref).not.toBe(outcome.masterHref);
  expect(outcome.symbolHref).toMatch(/^data:image\//);
});

test('an unloadable wash master degrades to the fallback symbol instead of hanging', async ({
  page,
}) => {
  await page.addInitScript(parkDecode);
  await openScene(page);

  const outcome = await page.evaluate(
    async ({ templates, baseCss, request }) => {
      const master = 'data:image/png;base64,bm90LWEtcG5n';
      window.__eraser.setup({ templates, baseCss, washMaster: master });
      const result = await window.__eraser.run(request);
      const image = document.querySelector('symbol[id^="er-wash-"] image');

      return {
        washedBox: result.layout.boxes['washed'],
        symbolHref: image?.getAttribute('href') ?? null,
        masterHref: master,
      };
    },
    {
      templates: Object.fromEntries(
        Object.entries(TEMPLATES).map(([name, { html, css }]) => [name, { html, css }]),
      ),
      baseCss: BASE_CSS,
      request: { ...splitScene(WASH_SCENE), icons: {} },
    },
  );

  // The load rejection surfaces as the documented degradation: the symbol wraps the master
  // itself so the wash paints uncolored, and the run still completes.
  expect(outcome.washedBox).toEqual({ x: 0, y: 0, width: 110, height: 30 });
  expect(outcome.symbolHref).toBe(outcome.masterHref);
});
