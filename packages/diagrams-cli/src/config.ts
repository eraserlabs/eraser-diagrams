import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type FontSource, type FontsConfig } from '@eraserlabs/resolve';
import { CliError } from './errors.js';

export const CONFIG_FILE_NAME = 'eraser-diagrams.config.json';
export const CONFIG_ENV = 'ERASER_DIAGRAMS_CONFIG';
export const CHROMIUM_ENV = 'CHROMIUM_PATH';

export const OUTPUT_FORMATS = ['png', 'html'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const UNKNOWN_ICON_POLICIES = ['placeholder', 'error'] as const;
export type UnknownIconPolicy = (typeof UNKNOWN_ICON_POLICIES)[number];

export interface IconsConfig {
  baseUrl?: string;
  cacheDir?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  onUnknown?: UnknownIconPolicy;
}

/** Validated shape of `eraser-diagrams.config.json`; paths are still as written. */
export interface FileConfig {
  chromiumPath?: string;
  format?: OutputFormat;
  outDir?: string;
  deviceScaleFactor?: number;
  pages?: number;
  icons?: IconsConfig;
  fonts?: FontsConfig | string;
  library?: string;
  overrides?: string;
  failOnWarning?: boolean;
}

/** Flag-level overrides. Paths are relative to the current directory. */
export interface ConfigOverrides {
  chromiumPath?: string;
  format?: OutputFormat;
  outDir?: string;
  deviceScaleFactor?: number;
  pages?: number;
  icons?: IconsConfig;
  /** Path to a fonts JSON file. */
  fonts?: string;
  failOnWarning?: boolean;
}

export type ChromiumSource = 'flag' | 'env' | 'config';

/** Merged flag > env > file > default; every path absolute; fonts loaded. */
export interface EffectiveConfig {
  configPath: string | null;
  chromiumPath?: string;
  chromiumSource?: ChromiumSource;
  format: OutputFormat;
  outDir: string;
  deviceScaleFactor: number;
  pages: number;
  icons: IconsConfig & { onUnknown: UnknownIconPolicy };
  fonts?: FontsConfig;
  library?: string;
  overrides?: string;
  failOnWarning: boolean;
}

export interface ResolveConfigInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  flags: ConfigOverrides;
  configFlag?: string;
  noConfig?: boolean;
}

/**
 * `--config` > `$ERASER_DIAGRAMS_CONFIG` > nearest `eraser-diagrams.config.json` walking up
 * from cwd. The walk stops after the first directory that contains `.git` (the project root),
 * so a config in a parent checkout or the home directory is never picked up.
 */
export function findConfigFile(input: ResolveConfigInput): string | null {
  if (input.noConfig) {
    return null;
  }

  if (input.configFlag !== undefined) {
    return resolve(input.cwd, input.configFlag);
  }

  const fromEnv = input.env[CONFIG_ENV];

  if (fromEnv) {
    return resolve(input.cwd, fromEnv);
  }

  let dir = resolve(input.cwd);

  for (;;) {
    const candidate = join(dir, CONFIG_FILE_NAME);

    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(dir);

    if (existsSync(join(dir, '.git')) || parent === dir) {
      return null;
    }

    dir = parent;
  }
}

function readJsonFile(path: string, what: string): unknown {
  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new CliError(`Cannot read ${what} ${path}: ${(error as Error).message}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`Invalid JSON in ${what} ${path}: ${(error as Error).message}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Check = (value: unknown, key: string) => void;

const isString: Check = (value, key) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliError(`Config key "${key}" must be a non-empty string.`);
  }
};

const isPositiveNumber: Check = (value, key) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new CliError(`Config key "${key}" must be a positive number.`);
  }
};

const isBoolean: Check = (value, key) => {
  if (typeof value !== 'boolean') {
    throw new CliError(`Config key "${key}" must be a boolean.`);
  }
};

function isOneOf(choices: readonly string[]): Check {
  return (value, key) => {
    if (typeof value !== 'string' || !choices.includes(value)) {
      throw new CliError(`Config key "${key}" must be one of ${choices.join(' | ')}.`);
    }
  };
}

const isFontsSpec: Check = (value, key) => {
  if (typeof value === 'string' && value.length > 0) {
    return;
  }

  if (!isPlainObject(value) || !isPlainObject(value['roles']) || !Array.isArray(value['faces'])) {
    throw new CliError(
      `Config key "${key}" must be a path to a fonts JSON file or an object with "roles" and "faces".`,
    );
  }
};

const ICON_CHECKS: Record<string, Check> = {
  baseUrl: isString,
  cacheDir: isString,
  timeoutMs: isPositiveNumber,
  cacheTtlMs: isPositiveNumber,
  onUnknown: isOneOf(UNKNOWN_ICON_POLICIES),
};

const isIconsObject: Check = (value, key) => {
  if (!isPlainObject(value)) {
    throw new CliError(`Config key "${key}" must be an object.`);
  }

  checkKeys(value, ICON_CHECKS, `${key}.`);
};

const FILE_CHECKS: Record<string, Check> = {
  $schema: () => undefined,
  chromiumPath: isString,
  format: isOneOf(OUTPUT_FORMATS),
  outDir: isString,
  deviceScaleFactor: isPositiveNumber,
  pages: isPositiveNumber,
  icons: isIconsObject,
  fonts: isFontsSpec,
  library: isString,
  overrides: isString,
  failOnWarning: isBoolean,
};

function checkKeys(
  object: Record<string, unknown>,
  checks: Record<string, Check>,
  prefix: string,
): void {
  for (const [key, value] of Object.entries(object)) {
    const check = checks[key];

    if (!check) {
      throw new CliError(
        `Unknown config key "${prefix}${key}". Known keys: ${Object.keys(checks)
          .filter((k) => k !== '$schema')
          .join(', ')}.`,
      );
    }

    check(value, `${prefix}${key}`);
  }
}

export function loadFileConfig(path: string): FileConfig {
  const raw = readJsonFile(path, 'config file');

  if (!isPlainObject(raw)) {
    throw new CliError(`Config file ${path} must contain a JSON object.`);
  }

  checkKeys(raw, FILE_CHECKS, '');
  const { $schema: _ignored, ...config } = raw;

  return config as FileConfig;
}

/** `file` and `file-from-url` faces name disk paths; staging reads them as given, so anchor them here. */
function resolveFontPaths(fonts: FontsConfig, baseDir: string): FontsConfig {
  const faces: FontSource[] = fonts.faces.map((face) => {
    if (face.kind === 'file') {
      return { ...face, path: resolve(baseDir, face.path) };
    }

    if (face.kind === 'file-from-url') {
      return { ...face, cachePath: resolve(baseDir, face.cachePath) };
    }

    return face;
  });

  return { ...fonts, faces };
}

/** Inline object: paths relative to `baseDir`. Path string: paths relative to that file's directory. */
export function loadFonts(spec: FontsConfig | string, baseDir: string): FontsConfig {
  if (typeof spec !== 'string') {
    return resolveFontPaths(spec, baseDir);
  }

  const path = resolve(baseDir, spec);
  const raw = readJsonFile(path, 'fonts file');
  isFontsSpec(raw, 'fonts');

  return resolveFontPaths(raw as FontsConfig, dirname(path));
}

function pickChromium(
  input: ResolveConfigInput,
  file: FileConfig,
  baseDir: string,
): Pick<EffectiveConfig, 'chromiumPath' | 'chromiumSource'> {
  if (input.flags.chromiumPath) {
    return { chromiumPath: resolve(input.cwd, input.flags.chromiumPath), chromiumSource: 'flag' };
  }

  const fromEnv = input.env[CHROMIUM_ENV];

  if (fromEnv) {
    return { chromiumPath: resolve(input.cwd, fromEnv), chromiumSource: 'env' };
  }

  if (file.chromiumPath) {
    return { chromiumPath: resolve(baseDir, file.chromiumPath), chromiumSource: 'config' };
  }

  return {};
}

export function resolveConfig(input: ResolveConfigInput): EffectiveConfig {
  const configPath = findConfigFile(input);
  const file: FileConfig = configPath ? loadFileConfig(configPath) : {};
  const baseDir = configPath ? dirname(configPath) : input.cwd;
  const { flags } = input;

  const fileIcons: IconsConfig = {
    ...file.icons,
    ...(file.icons?.cacheDir ? { cacheDir: resolve(baseDir, file.icons.cacheDir) } : {}),
  };
  const flagIcons: IconsConfig = {
    ...flags.icons,
    ...(flags.icons?.cacheDir ? { cacheDir: resolve(input.cwd, flags.icons.cacheDir) } : {}),
  };
  const icons = { ...fileIcons, ...flagIcons };

  const fonts =
    flags.fonts !== undefined
      ? loadFonts(flags.fonts, input.cwd)
      : file.fonts !== undefined
        ? loadFonts(file.fonts, baseDir)
        : undefined;

  return {
    configPath,
    ...pickChromium(input, file, baseDir),
    format: flags.format ?? file.format ?? 'png',
    outDir: flags.outDir
      ? resolve(input.cwd, flags.outDir)
      : file.outDir
        ? resolve(baseDir, file.outDir)
        : input.cwd,
    deviceScaleFactor: flags.deviceScaleFactor ?? file.deviceScaleFactor ?? 1,
    pages: flags.pages ?? file.pages ?? 1,
    icons: { ...icons, onUnknown: icons.onUnknown ?? 'placeholder' },
    ...(fonts ? { fonts } : {}),
    ...(file.library ? { library: resolve(baseDir, file.library) } : {}),
    ...(file.overrides ? { overrides: resolve(baseDir, file.overrides) } : {}),
    failOnWarning: flags.failOnWarning ?? file.failOnWarning ?? false,
  };
}
