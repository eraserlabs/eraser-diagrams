import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { IIFE_PATH, TEMPLATES } from './support/harness.js';
import type * as Elements from '@eraserlabs/render/elements';

declare global {
  interface Window {
    elementApi: typeof Elements;
  }
}

let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: "import * as api from '@eraserlabs/render/elements'; window.elementApi = api;",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    target: 'es2022',
    define: { 'process.env': '{}' },
  });
  bundle = result.outputFiles[0]!.text;
});
test.beforeEach(async ({ page }) => {
  await page.setContent('<div id="eraser-scene">Existing scene</div><div id="editor"></div>');
  await page.addScriptTag({ content: bundle });
});

test('partial render includes orphan nodes, connections and CSS without global side effects', async ({
  page,
}) => {
  const result = await page.evaluate(async (templates) => {
    const renderer = window.elementApi.createElementRenderer({ baseCss: '', templates });
    const input = {
      entities: [
        { tag: 'Card', id: 'a', containerId: 'missing', props: { label: 'subset', kind: 'k' } },
      ],
      connections: [
        {
          tag: 'Wire',
          id: 'w',
          props: { from: 'external-a', to: 'external-b', label: 'connection' },
        },
      ],
      icons: {},
    };
    const before = JSON.stringify(input);
    const fragment = await renderer.render(input);
    return {
      fragment,
      css: renderer.css,
      unchanged: JSON.stringify(input) === before,
      global: '__eraser' in window,
      scene: document.getElementById('eraser-scene')!.outerHTML,
      editor: document.getElementById('editor')!.innerHTML,
    };
  }, TEMPLATES);
  expect(result.fragment.elements.map((e) => e.id)).toEqual(['a', 'w']);
  expect(result.fragment.elements[0]!.html).toContain('subset');
  expect(result.fragment.elements[1]!.html).toContain('data-role="anchor"');
  expect(result.fragment.elements[1]!.html).toContain('connection');
  expect(result.css).toContain('@scope([data-mdp-tag="Card"])');
  expect(result.unchanged).toBe(true);
  expect(result.global).toBe(false);
  expect(result.scene).toBe('<div id="eraser-scene">Existing scene</div>');
  expect(result.editor).toBe('');
});

test('measures text policies independently and restores the caller’s host sizing', async ({
  page,
}) => {
  const result = await page.evaluate(async (templates) => {
    const api = window.elementApi;
    const renderer = api.createElementRenderer({ baseCss: '', templates });
    const entities = [
      {
        tag: 'TextPolicy',
        id: 'text',
        containerId: 'missing',
        width: 80,
        height: 16,
        props: { label: 'A'.repeat(72), policy: 'height-only' },
      },
    ];
    const fragment = await renderer.render({ entities, connections: [], icons: {} });
    const style = document.createElement('style');
    style.textContent = renderer.css;
    document.head.appendChild(style);
    const wrapper = document.createElement('div');
    wrapper.dataset.mdpTag = 'TextPolicy';
    wrapper.style.cssText = 'width: 300px; height: 50px; color: red;';
    wrapper.innerHTML = fragment.elements[0]!.html;
    document.getElementById('editor')!.appendChild(wrapper);
    const before = wrapper.getAttribute('style');
    const mounted = [{ id: 'text', tag: 'TextPolicy', wrapper }];
    const measures = await api.measureElements(mounted, entities);
    const current = await api.measureElements(mounted);
    return { measures, current, before, after: wrapper.getAttribute('style') };
  }, TEMPLATES);
  expect(result.measures[0]!.body!.width).toBe(80);
  expect(result.measures[0]!.body!.height).toBeGreaterThan(16);
  expect(result.measures[0]!.intrinsic.width).toBeGreaterThan(300);
  expect(result.measures[0]!.roles['internal-text']).toHaveLength(1);
  expect(result.current[0]!.body!.width).toBe(300);
  expect(result.current[0]!.body!.height).toBe(50);
  expect(result.after).toBe(result.before);
});

test('text measurement follows actual wrapping and inline markup without mutating it', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const root = document.createElement('div');
    root.style.cssText = 'font:16px/20px monospace;width:100px;padding:8px;';
    root.innerHTML = '<strong>Alpha beta</strong> gamma delta epsilon zeta';
    document.body.appendChild(root);
    const before = root.outerHTML;
    const narrow = await window.elementApi.measureText(root);
    const unchanged = root.outerHTML === before;
    root.style.width = '600px';
    const wide = await window.elementApi.measureText(root);
    root.replaceChildren();
    const empty = await window.elementApi.measureText(root);
    return { narrow, wide, empty, unchanged };
  });
  expect(result.narrow.bounds!.height).toBeGreaterThan(result.wide.bounds!.height);
  expect(result.narrow.bounds!.width).toBeLessThan(result.wide.bounds!.width);
  expect(result.narrow.bounds!.x).toBe(8);
  expect(result.unchanged).toBe(true);
  expect(result.empty).toEqual({ fragments: [], bounds: null });
});

test('watercolor preparation is reusable, colored, isolated and does not mutate input', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 2;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 4, 2);
    const master = canvas.toDataURL();
    const renderer = window.elementApi.createElementRenderer({
      baseCss: '',
      washMaster: master,
      templates: {
        Wash: {
          css: '',
          html: '<template name="Wash"><svg data-tpl="Wash"><clipPath id="clip-{{washUid}}"><rect width="4" height="2"/></clipPath><use href="#{{washSym}}" clip-path="url(#clip-{{washUid}})" width="4" height="2"/></svg></template>',
        },
      },
    });
    const request = {
      entities: [
        {
          tag: 'Wash',
          id: 'same',
          props: {
            washTexCss: true,
            washUid: 'same',
            washShade: '#004400',
            washMid: '#00cc00',
          },
        },
      ],
      connections: [],
      icons: {},
    };
    const before = JSON.stringify(request);
    const [first, second] = await Promise.all([renderer.render(request), renderer.render(request)]);
    const host = document.createElement('div');
    host.innerHTML = first.defs + first.elements[0]!.html;
    document.body.appendChild(host);
    const href = host.querySelector('use')!.getAttribute('href')!;
    const symbol = document.getElementById(href.slice(1))!;
    const image = new Image();
    image.src = symbol.querySelector('image')!.getAttribute('href')!;
    await image.decode();
    ctx.clearRect(0, 0, 4, 2);
    ctx.drawImage(image, 0, 0);
    const pixel = [...ctx.getImageData(0, 0, 1, 1).data];
    return { first, second, pixel, unchanged: JSON.stringify(request) === before };
  });
  expect(result.first.defs).toContain('<symbol');
  expect(result.first.elements[0]!.html).not.toContain('href="#"');
  expect(result.first.elements[0]!.html).not.toBe(result.second.elements[0]!.html);
  expect(result.unchanged).toBe(true);
  expect(result.pixel[1]).toBeGreaterThan(result.pixel[0]! + 100);
  expect(result.pixel[3]).toBeGreaterThan(0);
});

test('measurement rejects detached hosts instead of returning misleading zero dimensions', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const wrapper = document.createElement('div');
    return Promise.all([
      window.elementApi.measureText(wrapper).catch((e: Error) => e.message),
      window.elementApi
        .measureElements([{ id: 'a', tag: 'Card', wrapper }])
        .catch((e: Error) => e.message),
    ]);
  });
  expect(
    result.every((message) => typeof message === 'string' && message.includes('mounted')),
  ).toBe(true);
});

test('caller-supplied geometry paints a lone connection without its referenced entities', async ({
  page,
}) => {
  await page.evaluate(async (templates) => {
    const api = window.elementApi;
    const renderer = api.createElementRenderer({ baseCss: '', templates });
    const fragment = await renderer.render({
      entities: [],
      connections: [
        {
          tag: 'Wire',
          id: 'edge',
          props: { from: 'absent-a', to: 'absent-b', label: 'saved route' },
        },
      ],
      icons: {},
    });
    const style = document.createElement('style');
    style.textContent = renderer.css;
    document.head.appendChild(style);
    const wrapper = document.createElement('div');
    wrapper.dataset.mdpTag = 'Wire';
    wrapper.innerHTML = fragment.elements[0]!.html;
    const host = document.getElementById('editor')!;
    host.appendChild(wrapper);
    const mounted = [{ id: 'edge', tag: 'Wire', wrapper }];
    const measures = await api.measureElements(mounted);
    api.applyLayout(
      host,
      mounted,
      {
        boxes: {},
        scene: { x: 0, y: 0, width: 240, height: 80 },
        connections: {
          edge: {
            d: 'M 10 40 L 230 40',
            points: [
              [10, 40],
              [230, 40],
            ],
            label: { x: 120, y: 40 },
          },
        },
      },
      undefined,
      measures,
    );
  }, TEMPLATES);
  await expect(page.locator('#editor [data-role="anchor"]')).toHaveAttribute(
    'd',
    'M 10 40 L 230 40',
  );
  await expect(page.locator('#editor [data-role="external-text"]')).toHaveText('saved route');
  await expect(page.locator('#eraser-scene')).toHaveText('Existing scene');
});

test('standalone watercolor preparation separates concurrent masters and reuses each cached texture', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const master = (width: number, height: number, color: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, width, height);
      return canvas.toDataURL();
    };
    const masters = [master(8, 4, '#808080'), master(2, 6, '#404040')];
    const paint = () => ({ props: { washTexCss: true, washShade: '#004400', washMid: '#00cc00' } });
    const render = async (source: string) => {
      const elements = [paint(), paint()];
      const defs = await window.elementApi.prepareWashMasters(source, elements);
      const root = document.createElement('div');
      root.innerHTML = defs;
      const symbols = [...root.querySelectorAll('symbol')];
      return {
        box: symbols[0]!.getAttribute('viewBox'),
        href: symbols[0]!.querySelector('image')!.getAttribute('href'),
        count: symbols.length,
        sameSymbol: JSON.stringify(elements[0]) === JSON.stringify(elements[1]),
        defs,
      };
    };
    const [first, second] = await Promise.all(masters.map(render));
    const again = await render(masters[0]!);
    const empty = await window.elementApi.prepareWashMasters(undefined, [paint()]);
    return { first, second, again, empty };
  });
  expect(result.first!.box).toBe('0 0 8 4');
  expect(result.second!.box).toBe('0 0 2 6');
  expect(result.first!.href).not.toBe(result.second!.href);
  expect(result.again.href).toBe(result.first!.href);
  expect(result.again.defs).not.toBe(result.first!.defs);
  expect(result.first!.count).toBe(1);
  expect(result.first!.sameSymbol).toBe(true);
  expect(result.empty).toBe('');
});

test('measurement restores template styles and priorities, including on failure', async ({
  page,
}) => {
  const results = await page.evaluate(async () => {
    const stylesheet = document.createElement('style');
    stylesheet.textContent = '[data-role="internal-text"] { width: 200px !important; }';
    document.head.append(stylesheet);
    const results = [];
    for (const fail of [false, true]) {
      const wrapper = document.createElement('div');
      wrapper.dataset.mdpTag = 'Test';
      wrapper.style.cssText = 'width: 200px; height: 40px';
      wrapper.innerHTML =
        '<div data-role="body"><span data-role="internal-text" style="display:block;width:80px!important">Alpha beta gamma delta</span></div>';
      document.body.append(wrapper);
      const node = wrapper.querySelector('span')!;
      const original = wrapper.outerHTML;
      const readRect = node.getBoundingClientRect.bind(node);
      if (fail) {
        node.getBoundingClientRect = () => {
          if (node.style.width === 'min-content') {
            throw new Error('probe failed');
          }
          return readRect();
        };
      }
      let error: string | undefined;
      try {
        await window.elementApi.measureElements(
          [{ id: 'a', tag: 'Test', wrapper }],
          [{ id: 'a', tag: 'Test', width: 200, props: {} }],
        );
      } catch (e) {
        error = (e as Error).message;
      }
      stylesheet.sheet!.insertRule('[data-role="internal-text"] { color: red; }');
      results.push({
        fail,
        error,
        unchanged: wrapper.outerHTML === original,
        width: readRect().width,
        priority: node.style.getPropertyPriority('width'),
      });
      wrapper.remove();
    }
    return results;
  });
  for (const result of results) {
    expect(result.unchanged).toBe(true);
    expect(result.priority).toBe('important');
    expect(result.width).toBe(80);
    expect(result.error).toBe(result.fail ? 'probe failed' : undefined);
  }
});

test('independent full-scene and element bundles cannot collide on watercolor definitions', async ({
  page,
}) => {
  await page.addScriptTag({ path: IIFE_PATH });
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 4, 4);
    const setup = {
      washMaster: canvas.toDataURL(),
      baseCss: '',
      templates: {
        Wash: {
          css: '',
          html: '<template name="Wash"><svg data-tpl="Wash" data-role="body" width="4" height="4"><use href="#{{washSym}}" width="4" height="4"/></svg></template>',
        },
      },
    };
    const request = (color: string) => ({
      entities: [
        {
          id: 'same-element',
          tag: 'Wash',
          x: 0,
          y: 0,
          props: { washTexCss: true, washShade: color, washMid: color },
        },
      ],
      connections: [],
      icons: {},
    });
    window.__eraser.setup(setup);
    await window.__eraser.run(request('#ff0000'));
    const renderer = window.elementApi.createElementRenderer(setup);
    const automatic = await renderer.render(request('#00ff00'));
    const explicit = await renderer.render(request('#0000ff'), {
      idPrefix: 'preview-same-element',
    });
    const hosts = [automatic, explicit].map((fragment) => {
      const host = document.createElement('div');
      host.innerHTML = fragment.defs + fragment.elements[0]!.html;
      document.body.append(host);
      return host;
    });
    const ids = [...document.querySelectorAll('symbol')].map((node) => node.id);
    const correctTargets = hosts.every((host) => {
      const ref = host.querySelector('use')!.getAttribute('href')!.slice(1);
      return host.contains(document.getElementById(ref));
    });
    const image = new Image();
    image.src = hosts[0]!.querySelector('symbol image')!.getAttribute('href')!;
    await image.decode();
    ctx.clearRect(0, 0, 4, 4);
    ctx.drawImage(image, 0, 0);
    return {
      ids,
      correctTargets,
      pixel: [...ctx.getImageData(2, 2, 1, 1).data],
      explicit: explicit.defs,
    };
  });
  expect(new Set(result.ids).size).toBe(result.ids.length);
  expect(result.correctTargets).toBe(true);
  expect(result.explicit).toContain('id="preview-same-element-wash-0"');
  expect(result.pixel[1]).toBeGreaterThan(result.pixel[0]! + 100);
});

test('watercolor themes the paper stop without changing density or reusing the wrong texture', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 32;
    const ctx = canvas.getContext('2d')!;
    for (const [index, value] of [0, 128, 192, 255].entries()) {
      ctx.fillStyle = `rgb(${value}, ${value}, ${value})`;
      ctx.fillRect(index * 32, 0, 32, 32);
    }
    const master = canvas.toDataURL();
    const paint = (washPaper?: string) => ({
      props: {
        washTexCss: true,
        washShade: '#004400',
        washMid: '#00cc00',
        ...(washPaper === undefined ? {} : { washPaper }),
      } as Record<string, unknown>,
    });
    const elements = [paint(), paint('#ffffff'), paint('#171717')];
    const defs = await window.elementApi.prepareWashMasters(master, elements);
    const root = document.createElement('div');
    root.innerHTML = defs;
    const symbols = [...root.querySelectorAll('symbol')];
    const hrefs = symbols.map((symbol) => symbol.querySelector('image')!.getAttribute('href')!);
    const pixels = await Promise.all(
      hrefs.map(async (href) => {
        const image = new Image();
        image.src = href;
        await image.decode();
        const output = document.createElement('canvas');
        output.width = 128;
        output.height = 32;
        const context = output.getContext('2d')!;
        context.drawImage(image, 0, 0);
        return [16, 48, 80, 112].map((x) => [...context.getImageData(x, 16, 1, 1).data]);
      }),
    );
    const again = document.createElement('div');
    again.innerHTML = await window.elementApi.prepareWashMasters(master, [paint('#171717')]);
    return {
      symbols: symbols.length,
      defaultSymbol: elements[0]!.props.washSym,
      whiteSymbol: elements[1]!.props.washSym,
      darkSymbol: elements[2]!.props.washSym,
      hrefs,
      cachedDark: again.querySelector('image')!.getAttribute('href'),
      pixels,
    };
  });

  expect(result.symbols).toBe(2);
  expect(result.defaultSymbol).toBe(result.whiteSymbol);
  expect(result.darkSymbol).not.toBe(result.whiteSymbol);
  expect(result.hrefs[0]).not.toBe(result.hrefs[1]);
  expect(result.cachedDark).toBe(result.hrefs[1]);
  const [light, dark] = result.pixels;
  expect(light!.map((pixel) => pixel[3])).toEqual(dark!.map((pixel) => pixel[3]));
  expect(light![3]![3]).toBe(0);
  // At 75% source luminance the paper stop contributes half the RGB value.
  expect(light![2]![0]! - dark![2]![0]!).toBeGreaterThan(90);
  expect(light![2]![2]! - dark![2]![2]!).toBeGreaterThan(90);
  // The shade stop remains stable; webp encoding may vary individual channels slightly.
  for (let channel = 0; channel < 3; channel++) {
    expect(Math.abs(light![0]![channel]! - dark![0]![channel]!)).toBeLessThanOrEqual(4);
  }
});
