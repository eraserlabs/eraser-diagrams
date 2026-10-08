import { test, expect } from '@playwright/test';
import { normalizeFetchedIcon } from '../src/icons/svgTransforms.js';
import { buildPayload, runPayload } from './support/payload.js';

const PAYLOAD =
  '<svg xmlns="http://www.w3.org/2000/svg"><svg/onload=document.body.setAttribute("data-poc","executed")></svg></svg>';

test('the reported SVG payload executes in Chromium without sanitization', async ({ page }) => {
  await page.setContent('<body></body>');
  await page.evaluate((svg) => {
    document.body.innerHTML = svg;
  }, PAYLOAD);
  await expect(page.locator('body')).toHaveAttribute('data-poc', 'executed');
});

for (const normalized of [false, true]) {
  test(`renderer rejects the reported icon from a ${normalized ? 'normalized' : 'raw'} loader`, async ({
    page,
  }) => {
    const { payload, result } = await buildPayload(
      { elements: [{ tag: 'Icon', id: 'i', x: 0, y: 0, icon: 'evil' }] },
      { iconLoader: async () => (normalized ? normalizeFetchedIcon(PAYLOAD, 'evil') : PAYLOAD) },
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => warning.code === 'W_UNKNOWN_ICON')).toBe(true);
    expect(payload.icons['evil']).not.toContain('onload');
    await runPayload(page, payload);
    await expect(page.locator('[data-mdp-id="i"] svg')).toHaveCount(1);
    expect(await page.locator('body').getAttribute('data-poc')).toBeNull();
    await expect(page.locator('[onload]')).toHaveCount(0);
  });
}
