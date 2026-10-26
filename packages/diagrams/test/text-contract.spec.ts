import { test, expect } from '@playwright/test';
import { buildPayload, runPayload } from './support/payload.js';

test('code blocks wrap long tokens without losing indentation or authored newlines', async ({
  page,
}) => {
  const code = `  ${'customer_billing_production_'.repeat(4)}\n    next_line`;
  const { payload, result } = await buildPayload({
    elements: [
      {
        tag: 'Textbox',
        id: 'code',
        x: 0,
        y: 0,
        width: 220,
        fixedWidth: true,
        text: `\`\`\`\n${code}\n\`\`\``,
      },
    ],
  });
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  await runPayload(page, payload);
  const pre = page.locator('[data-mdp-id="code"] pre');
  await expect(pre).toHaveAttribute('data-md', 'code-block');
  expect(await pre.locator('code').textContent()).toBe(code);
  const bounds = await pre.evaluate((element) => {
    const codeElement = element.querySelector('code')!;
    const range = document.createRange();
    range.selectNodeContents(codeElement);
    const lines = [...range.getClientRects()];
    const box = element.getBoundingClientRect();
    return {
      width: box.width,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      lineCount: new Set(lines.map((line) => line.top)).size,
      allLinesInside: lines.every((line) => line.left >= box.left && line.right <= box.right),
    };
  });
  expect(bounds.width).toBeLessThanOrEqual(220);
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  expect(bounds.lineCount).toBeGreaterThan(2);
  expect(bounds.allLinesInside).toBe(true);
});
