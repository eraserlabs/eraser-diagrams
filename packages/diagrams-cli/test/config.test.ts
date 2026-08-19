import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_FILE_NAME,
  findConfigFile,
  loadFileConfig,
  resolveConfig,
  type ResolveConfigInput,
} from '../src/config.js';
import { CliError } from '../src/errors.js';

function tree(): string {
  return mkdtempSync(join(tmpdir(), 'eraser-cli-config-'));
}

function writeConfig(dir: string, config: unknown, name = CONFIG_FILE_NAME): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(config));

  return path;
}

function input(cwd: string, overrides: Partial<ResolveConfigInput> = {}): ResolveConfigInput {
  return { cwd, env: {}, flags: {}, ...overrides };
}

describe('findConfigFile', () => {
  it('walks up from cwd and takes the nearest file', () => {
    const root = tree();
    const parent = writeConfig(root, {});
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findConfigFile(input(nested))).toBe(parent);

    const nearer = writeConfig(join(root, 'a'), {});
    expect(findConfigFile(input(nested))).toBe(nearer);
  });

  it('stops after the directory that contains .git', () => {
    const root = tree();
    writeConfig(root, {});
    const project = join(root, 'project');
    mkdirSync(join(project, '.git'), { recursive: true });
    const nested = join(project, 'src');
    mkdirSync(nested);
    expect(findConfigFile(input(nested))).toBeNull();

    const own = writeConfig(project, {});
    expect(findConfigFile(input(nested))).toBe(own);
  });

  it('--config beats the env var, which beats discovery; --no-config disables everything', () => {
    const root = tree();
    writeConfig(root, {});
    const fromEnv = writeConfig(join(root, 'env'), {}, 'env.json');
    const fromFlag = writeConfig(join(root, 'flag'), {}, 'flag.json');
    const env = { ERASER_DIAGRAMS_CONFIG: fromEnv };

    expect(findConfigFile(input(root, { env }))).toBe(fromEnv);
    expect(findConfigFile(input(root, { env, configFlag: fromFlag }))).toBe(fromFlag);
    expect(findConfigFile(input(root, { env, noConfig: true }))).toBeNull();
  });
});

describe('loadFileConfig', () => {
  it('rejects unknown keys, wrong types, and non-object files', () => {
    const root = tree();
    expect(() => loadFileConfig(writeConfig(root, { chromium: '/x' }))).toThrow(
      /Unknown config key "chromium"/,
    );
    expect(() => loadFileConfig(writeConfig(root, { pages: '2' }))).toThrow(
      /"pages" must be a positive number/,
    );
    expect(() => loadFileConfig(writeConfig(root, { format: 'svg' }))).toThrow(/png \| html/);
    expect(() => loadFileConfig(writeConfig(root, { icons: { onUnknown: 'warn' } }))).toThrow(
      /"icons.onUnknown"/,
    );
    expect(() => loadFileConfig(writeConfig(root, { icons: { url: 'x' } }))).toThrow(/"icons.url"/);
    expect(() => loadFileConfig(writeConfig(root, []))).toThrow(/JSON object/);
    expect(() => loadFileConfig(writeConfig(root, { fonts: { roles: {} } }))).toThrow(/"fonts"/);
  });

  it('reports unreadable and malformed files as CliError', () => {
    const root = tree();
    expect(() => loadFileConfig(join(root, 'nope.json'))).toThrow(CliError);
    const bad = join(root, 'bad.json');
    writeFileSync(bad, '{');
    expect(() => loadFileConfig(bad)).toThrow(/Invalid JSON in config file/);
  });

  it('accepts and drops $schema', () => {
    const root = tree();
    expect(loadFileConfig(writeConfig(root, { $schema: 'x', pages: 2 }))).toEqual({ pages: 2 });
  });
});

describe('resolveConfig', () => {
  it('applies built-in defaults without a config file', () => {
    const root = tree();
    const config = resolveConfig(input(root));
    expect(config).toMatchObject({
      configPath: null,
      format: 'png',
      outDir: root,
      deviceScaleFactor: 1,
      pages: 1,
      icons: { onUnknown: 'placeholder' },
      failOnWarning: false,
    });
    expect(config.chromiumPath).toBeUndefined();
  });

  it('flag > env > file for chromiumPath, with provenance', () => {
    const root = tree();
    writeConfig(root, { chromiumPath: '/from/config' });
    expect(resolveConfig(input(root))).toMatchObject({
      chromiumPath: '/from/config',
      chromiumSource: 'config',
    });
    expect(resolveConfig(input(root, { env: { CHROMIUM_PATH: '/from/env' } }))).toMatchObject({
      chromiumPath: '/from/env',
      chromiumSource: 'env',
    });
    expect(
      resolveConfig(
        input(root, { env: { CHROMIUM_PATH: '/from/env' }, flags: { chromiumPath: '/from/flag' } }),
      ),
    ).toMatchObject({ chromiumPath: '/from/flag', chromiumSource: 'flag' });
  });

  it('flags override file values; icons merge per key', () => {
    const root = tree();
    writeConfig(root, {
      format: 'html',
      pages: 4,
      icons: { baseUrl: 'https://icons.example/', onUnknown: 'error' },
      failOnWarning: true,
    });
    const config = resolveConfig(
      input(root, { flags: { format: 'png', icons: { baseUrl: 'https://other/' } } }),
    );
    expect(config.format).toBe('png');
    expect(config.pages).toBe(4);
    expect(config.icons).toEqual({ baseUrl: 'https://other/', onUnknown: 'error' });
    expect(config.failOnWarning).toBe(true);
  });

  it('resolves file paths against the config directory and flag paths against cwd', () => {
    const root = tree();
    const project = join(root, 'project');
    writeConfig(project, {
      chromiumPath: 'bin/chrome',
      outDir: 'out',
      icons: { cacheDir: '.cache' },
      library: 'lib/index.mjs',
      overrides: 'lib/overrides.mjs',
    });
    const cwd = join(project, 'src');
    mkdirSync(cwd);

    const fromFile = resolveConfig(input(cwd));
    expect(fromFile.chromiumPath).toBe(join(project, 'bin/chrome'));
    expect(fromFile.outDir).toBe(join(project, 'out'));
    expect(fromFile.icons.cacheDir).toBe(join(project, '.cache'));
    expect(fromFile.library).toBe(join(project, 'lib/index.mjs'));
    expect(fromFile.overrides).toBe(join(project, 'lib/overrides.mjs'));

    const fromFlags = resolveConfig(
      input(cwd, { flags: { outDir: 'dist', icons: { cacheDir: 'c' } } }),
    );
    expect(fromFlags.outDir).toBe(join(cwd, 'dist'));
    expect(fromFlags.icons.cacheDir).toBe(join(cwd, 'c'));
  });

  it('inline fonts resolve against the config dir; a fonts file resolves against its own dir', () => {
    const root = tree();
    const project = join(root, 'project');
    const fontsDir = join(project, 'assets', 'fonts');
    mkdirSync(fontsDir, { recursive: true });
    const face = { kind: 'file', family: 'Inter', path: 'Inter.woff2' };
    const cached = {
      kind: 'file-from-url',
      family: 'Mono',
      url: 'https://x/m.woff2',
      cachePath: 'cache/m.woff2',
    };
    writeFileSync(
      join(fontsDir, 'fonts.json'),
      JSON.stringify({ roles: { clean: 'Inter' }, faces: [face, cached] }),
    );

    writeConfig(project, { fonts: { roles: { clean: 'Inter' }, faces: [face] } });
    const inline = resolveConfig(input(project));
    expect(inline.fonts?.faces[0]).toMatchObject({ path: join(project, 'Inter.woff2') });

    writeConfig(project, { fonts: 'assets/fonts/fonts.json' });
    const fromFile = resolveConfig(input(project));
    expect(fromFile.fonts?.faces[0]).toMatchObject({ path: join(fontsDir, 'Inter.woff2') });
    expect(fromFile.fonts?.faces[1]).toMatchObject({ cachePath: join(fontsDir, 'cache/m.woff2') });

    const fromFlag = resolveConfig(
      input(root, { flags: { fonts: 'project/assets/fonts/fonts.json' } }),
    );
    expect(fromFlag.fonts?.faces[0]).toMatchObject({ path: join(fontsDir, 'Inter.woff2') });
  });
});
