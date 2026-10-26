import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { scaleColorForTheme } from '@eraserlabs/resolve';
import type * as Elements from '@eraserlabs/render/elements';
import { createRenderer, stockLibrary, type RenderRequest } from '../src/index.js';
import { CHROMIUM_PATH } from './support/browser.js';
import { allTagsDocument } from './support/documents.js';
import { buildPayload, runPayload } from './support/payload.js';

declare global {
  interface Window {
    themeElementApi: typeof Elements;
  }
}

/** The existing all-tags fixture plus BPMN, nested authored paints, and both code presentations. */
function mixedDocument() {
  const elements = structuredClone([
    ...('elements' in allTagsDocument ? allTagsDocument.elements : []),
  ]) as Record<string, unknown>[];
  const element = (id: string) => elements.find((entry) => entry.id === id)!;
  Object.assign(element('s1'), {
    color: '#00ffff',
    texts: [{ text: 'Service `id`' }],
  });
  element('s1').bgColor = undefined;
  Object.assign(element('i1'), {
    color: '#123456',
    texts: [{ text: 'Database', color: '#345678' }],
  });
  Object.assign(element('g1'), {
    color: '#00ffff',
    title: {
      text: 'Cluster',
      color: '#123456',
      bgColor: '#ffeecc',
      icon: 'lucide-database',
      iconProps: { color: '#008000' },
    },
    badge: { text: '2', color: '#123456', bgColor: '#ffeecc' },
  });
  Object.assign(element('tb1'), { width: 300, height: 80, y: 110 });
  element('tb1').text =
    'A `code` note and [link](https://example.com)\n\n```js\nconst answer = 42;\n```';
  Object.assign(element('r1'), { color: '#654321', labelColor: '#123456' });
  for (const [index, tag] of ['Activity', 'Event', 'Gateway'].entries()) {
    elements.push({
      tag,
      id: tag,
      x: 600,
      y: 200 + index * 140,
      width: 140,
      height: 80,
      texts: [{ text: tag }],
    });
  }
  elements.push(
    {
      tag: 'Shape',
      id: 'wash',
      x: 600,
      y: 0,
      width: 140,
      height: 80,
      color: '#00ffff',
      styleMode: 'watercolor',
      texts: [{ text: 'Wash' }],
    },
    {
      tag: 'Shape',
      id: 'dark-fill',
      x: 400,
      y: 600,
      width: 160,
      height: 80,
      bgColor: '#000000',
      styleMode: 'plain',
      texts: [{ text: 'Read `customer_id`' }],
    },
  );
  return { elements };
}

function rgb(hex: string): string {
  const digits = hex.slice(1);
  return `rgb(${[0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16)).join(', ')})`;
}

async function paintSnapshot(page: Page, parent: string) {
  return page.locator(parent).evaluate((root) =>
    Object.fromEntries(
      [...root.querySelectorAll<HTMLElement>('[data-mdp-id]')].map((host) => [
        host.dataset.mdpId!,
        [
          ...host.querySelectorAll(
            [
              '[data-tpl]',
              '.er-shape__inner',
              '.er-shape__text',
              '.er-icon__glyph',
              '.er-icon__caption-line',
              '.er-grouplike__title',
              '.er-dbtable__head',
              '.er-dbtable__f-name',
              '.er-dbtable__f-type',
              '.er-legend__swatch',
              '.er-activity__line',
              '.er-event__disc',
              '.er-gateway__path',
              '[data-role="anchor"]',
              '[data-role="external-text"]',
              '.er-md code',
            ].join(','),
          ),
        ].map((node) => {
          const css = getComputedStyle(node);
          return {
            color: css.color,
            background: css.backgroundColor,
            border: css.borderTopColor,
            fill: css.fill,
            stroke: css.stroke,
            shadow: css.boxShadow,
          };
        }),
      ]),
    ),
  );
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} themes every stock template, nested paints, and code together`, async ({
    page,
  }) => {
    const input = mixedDocument();
    const before = JSON.stringify(input);
    const { payload, result } = await buildPayload(input, {
      theme,
      highlightCode: (code) => [{ text: code, className: 'hljs-keyword' }],
    });
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    await runPayload(page, payload);
    await expect(page.locator('#eraser-scene')).toHaveAttribute('data-er-theme', theme);
    const roots = await page.locator('[data-tpl]').evaluateAll((nodes) =>
      nodes.map((node) => ({
        tag: node.getAttribute('data-tpl'),
        theme: node.getAttribute('data-er-theme'),
      })),
    );
    expect([...new Set(roots.map((root) => root.tag))].sort()).toEqual(
      [...stockLibrary.manifest].sort(),
    );
    expect(roots.every((root) => root.theme === theme)).toBe(true);
    const host = (id: string) => page.locator(`[data-mdp-id="${id}"]`);
    const paint = (source: string) => rgb(scaleColorForTheme(source, theme));
    const ink = theme === 'dark' ? 'rgb(226, 226, 226)' : 'rgb(36, 36, 36)';
    const ground = theme === 'dark' ? 'rgb(23, 23, 23)' : 'rgb(255, 255, 255)';

    // Final paints and nested overrides use the same theme pass.
    const paints = [
      ['s1', '.er-shape__inner', 'background-color', paint('#b3ffff')],
      ['s1', '.er-shape__inner', 'border-top-color', paint('#00ffff')],
      ['g1', '[data-role="body"]', 'background-color', paint('#f5ffff')],
      ['s1', '.er-shape__text', 'color', ink],
      ['s1', '[data-tpl="Badge"]', 'background-color', paint('#f5ffff')],
      ['s1', '[data-tpl="Badge"]', 'color', ink],
      ['i1', '.er-icon__glyph', 'color', paint('#123456')],
      ['i1', '.er-icon__caption-line', 'color', paint('#345678')],
      ['g1', '.er-grouplike__title', 'background-color', paint('#ffeecc')],
      ['g1', '.er-grouplike__title-text', 'color', paint('#123456')],
      ['g1', '.er-grouplike__title-icon', 'color', paint('#008000')],
      ['g1', '[data-tpl="Badge"]', 'color', paint('#123456')],
      ['g1', '[data-tpl="Badge"]', 'background-color', paint('#ffeecc')],
    ] as const;
    for (const [id, selector, property, value] of paints) {
      await expect(host(id).locator(selector)).toHaveCSS(property, value);
    }
    await expect(host('lg1').locator('.er-legend__swatch').first()).toHaveCSS(
      'background-color',
      paint('#00aa77'),
    );
    await expect(host('r1').locator('[data-role="anchor"]')).toHaveCSS('stroke', paint('#654321'));
    await expect(host('r1').locator('[data-role="external-text"]')).toHaveCSS(
      'color',
      paint('#123456'),
    );
    await expect(host('r2').locator('[data-role="anchor"]')).toHaveCSS('stroke', paint('#1c1c1c'));
    await expect(host('d1').locator('.er-divider__line').first()).toHaveCSS(
      'border-top-color',
      paint('#1c1c1c'),
    );

    // Unauthored defaults across groups, tables and BPMN are readable on the matching surface.
    for (const id of ['l1', 'p1']) {
      await expect(host(id).locator('.er-grouplike__title-text')).toHaveCSS('color', ink);
    }
    await expect(host('t1').locator('.er-dbtable__head')).toHaveCSS('background-color', ground);
    await expect(host('t1').locator('.er-dbtable__title')).toHaveCSS('color', ink);
    await expect(host('t1').locator('.er-dbtable__f-type').first()).toHaveCSS(
      'color',
      paint('#737373'),
    );
    await expect(host('Activity').locator('[data-tpl]')).toHaveCSS('background-color', ground);
    await expect(host('Event').locator('.er-event__disc')).toHaveCSS('background-color', ground);
    await expect(host('Gateway').locator('.er-gateway__path')).toHaveCSS('fill', ground);
    for (const id of ['Activity', 'Event', 'Gateway']) {
      await expect(host(id).locator('.er-md')).toHaveCSS('color', ink);
    }

    // Code owns a coordinated foreground/background even on a dark authored fill in light mode.
    const codeInk = theme === 'dark' ? 'rgb(255, 255, 255)' : 'rgb(23, 23, 23)';
    const codeGround = theme === 'dark' ? 'rgb(36, 36, 36)' : 'rgb(250, 250, 250)';
    await expect(host('dark-fill').locator('code')).toHaveCSS('color', codeInk);
    await expect(host('dark-fill').locator('code')).toHaveCSS('background-color', codeGround);
    await expect(host('tb1').locator('pre')).toHaveCSS('background-color', codeGround);
    await expect(host('tb1').locator('.hljs-keyword')).toHaveCSS(
      'color',
      theme === 'dark' ? 'rgb(244, 112, 103)' : 'rgb(215, 58, 73)',
    );
    await expect(host('wash').locator('.er-washtex use')).toHaveAttribute('href', /^#/);
    expect(result.entities!.find((entity) => entity.id === 'wash')!.props.washPaper).toBe(
      theme === 'dark' ? '#171717' : '#ffffff',
    );
  });
}

test('fragment rendering carries its theme without a caller attribute and isolates nested light content', async ({
  page,
}) => {
  const light = await buildPayload(mixedDocument(), { theme: 'light' });
  const dark = await buildPayload(mixedDocument(), { theme: 'dark' });
  expect(light.result.ok).toBe(true);
  expect(dark.result.ok).toBe(true);
  await runPayload(page, light.payload);
  const expectedLight = await paintSnapshot(page, '#eraser-scene');
  await runPayload(page, dark.payload);
  const expectedDark = await paintSnapshot(page, '#eraser-scene');
  const bundle = await build({
    stdin: {
      contents: "import * as api from '@eraserlabs/render/elements'; window.themeElementApi = api;",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    target: 'es2022',
    define: { 'process.env': '{}' },
  });
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await page.evaluate(
    async ({ lightPayload, darkPayload }) => {
      const renderer = window.themeElementApi.createElementRenderer(lightPayload);
      for (const [theme, payload] of [
        ['light', lightPayload],
        ['dark', darkPayload],
      ] as const) {
        // Deliberately omit request.theme: the resolved elements already carry their presentation.
        const fragment = await renderer.render(
          {
            entities: payload.entities,
            connections: payload.connections,
            icons: payload.icons,
          },
          { idPrefix: `theme-${theme}` },
        );
        const parent = document.createElement('section');
        parent.id = `fragments-${theme}`;
        // The light fragment must reset theme defaults inherited from this unrelated dark host.
        if (theme === 'light') {
          parent.dataset.erTheme = 'dark';
        }
        parent.innerHTML = fragment.defs;
        for (const element of fragment.elements) {
          const wrapper = document.createElement('div');
          wrapper.dataset.mdpId = element.id;
          wrapper.dataset.mdpTag = element.tag;
          wrapper.style.cssText = 'width:160px;height:100px;position:relative';
          wrapper.innerHTML = element.html;
          parent.appendChild(wrapper);
        }
        document.body.appendChild(parent);
      }
    },
    { lightPayload: light.payload, darkPayload: dark.payload },
  );
  expect(await paintSnapshot(page, '#fragments-light')).toEqual(expectedLight);
  expect(await paintSnapshot(page, '#fragments-dark')).toEqual(expectedDark);
  await expect(page.locator('#fragments-dark')).not.toHaveAttribute('data-er-theme');
  await expect(page.locator('#fragments-light [data-tpl="Textbox"]')).toHaveAttribute(
    'data-er-theme',
    'light',
  );
  await expect(page.locator('#fragments-dark [data-tpl="Textbox"]')).toHaveAttribute(
    'data-er-theme',
    'dark',
  );
});

test('a null high-level request still returns validation errors', async () => {
  const renderer = await createRenderer({ chromiumPath: CHROMIUM_PATH, theme: 'dark' });
  try {
    const result = await renderer.render(null as unknown as RenderRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  } finally {
    await renderer.close();
  }
});

test('stock CSS preserves legacy light paints and inherited colors in both themes', async ({
  page,
}) => {
  const elements: Record<string, unknown>[] = [
    ...['Shape', 'Group', 'Lane', 'Pool', 'Activity', 'Event', 'Gateway', 'DatabaseTable'].map(
      (tag, index) => ({
        tag,
        id: tag,
        x: index * 180,
        y: 0,
        width: 160,
        height: 100,
        color: '#00ffff',
        ...(['Group', 'Lane', 'Pool'].includes(tag) ? { title: { text: tag } } : {}),
        ...(tag === 'DatabaseTable'
          ? { label: 'users', fields: [{ name: 'id', type: 'uuid' }] }
          : {}),
      }),
    ),
    {
      tag: 'Shape',
      id: 'explicit',
      x: 0,
      y: 160,
      width: 160,
      height: 100,
      color: '#ff0000',
      bgColor: '#00ffff',
      borderColor: '#0000ff',
    },
  ];
  const { payload, result } = await buildPayload({ elements }, { normalizers: {} });
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  for (const entity of payload.entities) {
    expect(entity.props.fillColor).toBeUndefined();
  }
  // Reproduce the resolved payload shape emitted before theme metadata was introduced.
  const { theme: _theme, ...legacyPayload } = payload;
  legacyPayload.entities = payload.entities.map(({ theme: _elementTheme, ...entity }) => entity);
  await runPayload(page, legacyPayload);
  for (const mode of ['light', 'legacy', 'inherited-light', 'inherited-dark']) {
    if (mode === 'legacy') {
      // Older renderers mount the same stock templates without a theme attribute at all.
      await page.locator('[data-er-theme]').evaluateAll((nodes) => {
        for (const node of nodes) {
          node.removeAttribute('data-er-theme');
        }
      });
    }
    if (mode.startsWith('inherited-')) {
      await page.locator('[data-mdp-id]:not([data-mdp-id="explicit"]) > [data-tpl]').evaluateAll(
        (nodes, theme) => {
          for (const node of nodes as HTMLElement[]) {
            node.dataset.erTheme = theme;
            node.dataset.color = 'currentColor';
            node.style.setProperty('--er-color', 'currentColor');
            node.style.color = '#00ffff';
          }
        },
        mode === 'inherited-dark' ? 'dark' : 'light',
      );
    }
    const paints = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      const paint = (id: string, selector: string, property: string) => {
        const host = document.querySelector(`[data-mdp-id="${id}"]`)!;
        const css = getComputedStyle(host.querySelector(selector)!);
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = css.getPropertyValue(property);
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      };
      return {
        shape: paint('Shape', '.er-shape__inner', 'background-color'),
        shapeBorder: paint('Shape', '.er-shape__inner', 'border-top-color'),
        group: paint('Group', '[data-role="body"]', 'background-color'),
        lane: paint('Lane', '[data-role="body"]', 'background-color'),
        pool: paint('Pool', '[data-role="body"]', 'background-color'),
        title: paint('Group', '.er-grouplike__title', 'background-color'),
        activity: paint('Activity', '[data-role="body"]', 'background-color'),
        event: paint('Event', '.er-event__disc', 'background-color'),
        gateway: paint('Gateway', '.er-gateway__path', 'fill'),
        table: paint('DatabaseTable', '[data-role="body"]', 'background-color'),
        divider: paint('DatabaseTable', '.er-dbtable__head', 'border-bottom-color'),
        explicit: paint('explicit', '.er-shape__inner', 'background-color'),
        explicitBorder: paint('explicit', '.er-shape__inner', 'border-top-color'),
      };
    });
    const dark = mode === 'inherited-dark';
    const surface = (red: number) => (dark ? [23, 23, 23, 255] : [red, 255, 255, 255]);
    expect(paints, mode).toEqual({
      shape: surface(179),
      shapeBorder: [0, 255, 255, 255],
      group: surface(245),
      lane: surface(245),
      pool: surface(245),
      // currentColor follows the title's own neutral text color, not the body's cyan ink.
      title: mode === 'inherited-light' ? [217, 217, 217, 255] : surface(179),
      activity: surface(235),
      event: surface(235),
      gateway: surface(235),
      table: surface(245),
      divider: dark ? [60, 60, 60, 255] : [214, 255, 255, 255],
      explicit: [0, 255, 255, 255],
      explicitBorder: [0, 0, 255, 255],
    });
  }
});
