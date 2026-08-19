import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stockLibrary } from '@eraserlabs/diagrams';
import { afterAll, describe, expect, it } from 'vitest';
import type { EffectiveConfig } from '../src/config.js';
import { CliError } from '../src/errors.js';
import {
  rendererOptionsFrom,
  iconLoaderFrom,
  loadLibraryModule,
  loadOverridesModule,
  resolverSetupFrom,
} from '../src/setup.js';

// Inside the package so vitest's module runner is allowed to import the fixture modules.
const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-setup-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function moduleFile(name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);

  return path;
}

function config(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return {
    configPath: null,
    format: 'png',
    outDir: dir,
    deviceScaleFactor: 1,
    pages: 1,
    icons: { onUnknown: 'placeholder' },
    failOnWarning: false,
    ...overrides,
  };
}

const LIBRARY_SOURCE = `export const library = { manifest: ['Card'], schemas: {}, templates: [], baseCss: '' };`;

describe('library and overrides modules', () => {
  it('loads `library`; a missing `normalizers` export becomes {} (never the stock table)', async () => {
    const path = moduleFile('lib.mjs', LIBRARY_SOURCE);
    const loaded = await loadLibraryModule(path);
    expect(loaded.library.manifest).toEqual(['Card']);
    expect(loaded.normalizers).toEqual({});
  });

  it('passes exported normalizers through', async () => {
    const path = moduleFile(
      'lib-n.mjs',
      `${LIBRARY_SOURCE}\nexport const normalizers = { Card: (element) => element };`,
    );
    expect(Object.keys((await loadLibraryModule(path)).normalizers)).toEqual(['Card']);
  });

  it('rejects modules without the expected export, and unloadable paths', async () => {
    const path = moduleFile('bad.mjs', 'export const nope = 1;');
    await expect(loadLibraryModule(path)).rejects.toThrow(/must export "library"/);
    await expect(loadOverridesModule(path)).rejects.toThrow(/must export "overrides"/);
    await expect(loadLibraryModule(join(dir, 'missing.mjs'))).rejects.toThrow(CliError);
  });

  it('loads `overrides`', async () => {
    const path = moduleFile(
      'ov.mjs',
      `export const overrides = { templates: [{ name: 'Shape', html: '<template name="Shape"><div data-tpl></div></template>', css: '' }] };`,
    );
    expect((await loadOverridesModule(path)).templates[0]?.name).toBe('Shape');
  });
});

describe('option shaping', () => {
  it('iconLoaderFrom is undefined until an icon loader key is set', () => {
    expect(iconLoaderFrom({ onUnknown: 'placeholder' })).toBeUndefined();
    expect(typeof iconLoaderFrom({ baseUrl: 'https://icons.example/' })).toBe('function');
    expect(typeof iconLoaderFrom({ cacheDir: dir })).toBe('function');
  });

  it('resolverSetupFrom defaults to the stock library and forwards resolver knobs', async () => {
    const setup = await resolverSetupFrom(config({ icons: { onUnknown: 'error' } }));
    expect(setup.library).toBe(stockLibrary);
    expect(setup.normalizers).toBeUndefined();
    expect(setup.iconLoader).toBeUndefined();
    expect(setup).toMatchObject({ onUnknownIcon: 'error' });
  });

  it('resolverSetupFrom wires a custom library with its normalizers and overrides', async () => {
    const library = moduleFile('lib2.mjs', LIBRARY_SOURCE);
    const overrides = moduleFile('ov2.mjs', `export const overrides = { templates: [] };`);
    const setup = await resolverSetupFrom(config({ library, overrides }));
    expect(setup.library.manifest).toEqual(['Card']);
    expect(setup.normalizers).toEqual({});
    expect(setup.overrides).toEqual({ templates: [] });
  });

  it('rendererOptionsFrom adds the browser and boot-time render knobs', async () => {
    const fonts = { roles: { clean: 'Inter' }, faces: [] };
    const options = await rendererOptionsFrom(
      config({ pages: 3, deviceScaleFactor: 2, fonts }),
      '/path/to/chrome',
    );
    expect(options).toMatchObject({
      chromiumPath: '/path/to/chrome',
      pages: 3,
      deviceScaleFactor: 2,
      fonts,
      library: stockLibrary,
    });
  });
});
