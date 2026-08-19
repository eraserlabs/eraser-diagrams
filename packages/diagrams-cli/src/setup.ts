import { pathToFileURL } from 'node:url';
import { createEraserIconLoader, stockLibrary, type RendererOptions } from '@eraserlabs/diagrams';
import type {
  AuthoredLibrary,
  ElementNormalizer,
  IconLoader,
  ResolverSetup,
  TemplateOverrides,
} from '@eraserlabs/resolve';
import type { EffectiveConfig, IconsConfig } from './config.js';
import { CliError } from './errors.js';

interface LibraryModule {
  library: AuthoredLibrary;
  normalizers: Record<string, ElementNormalizer>;
}

async function importModule(path: string, what: string): Promise<Record<string, unknown>> {
  try {
    return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  } catch (error) {
    throw new CliError(`Cannot load ${what} module ${path}: ${(error as Error).message}`);
  }
}

/**
 * `export const library: AuthoredLibrary` plus optional `export const normalizers`. A custom
 * vocabulary without normalizers gets `{}`, never the stock table (`createRenderer` would
 * otherwise substitute it).
 */
export async function loadLibraryModule(path: string): Promise<LibraryModule> {
  const mod = await importModule(path, 'library');
  const library = mod['library'];

  if (
    typeof library !== 'object' ||
    library === null ||
    !Array.isArray((library as AuthoredLibrary).manifest)
  ) {
    throw new CliError(`Library module ${path} must export "library" (an AuthoredLibrary).`);
  }

  const normalizers = mod['normalizers'];

  return {
    library: library as AuthoredLibrary,
    normalizers:
      typeof normalizers === 'object' && normalizers !== null
        ? (normalizers as Record<string, ElementNormalizer>)
        : {},
  };
}

/** `export const overrides: TemplateOverrides` ({ templates: TemplateFile[] }). */
export async function loadOverridesModule(path: string): Promise<TemplateOverrides> {
  const mod = await importModule(path, 'overrides');
  const overrides = mod['overrides'];

  if (
    typeof overrides !== 'object' ||
    overrides === null ||
    !Array.isArray((overrides as TemplateOverrides).templates)
  ) {
    throw new CliError(
      `Overrides module ${path} must export "overrides" ({ templates: TemplateFile[] }).`,
    );
  }

  return overrides as TemplateOverrides;
}

/** Undefined when nothing is customized, so `createRenderer` keeps its own default loader. */
export function iconLoaderFrom(icons: IconsConfig): IconLoader | undefined {
  const { baseUrl, cacheDir, timeoutMs, cacheTtlMs } = icons;

  if (
    baseUrl === undefined &&
    cacheDir === undefined &&
    timeoutMs === undefined &&
    cacheTtlMs === undefined
  ) {
    return undefined;
  }

  return createEraserIconLoader({
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(cacheDir !== undefined ? { cacheDir } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}),
  });
}

/** Browserless setup shared by validate/registry/schema. */
export async function resolverSetupFrom(config: EffectiveConfig): Promise<ResolverSetup> {
  const custom = config.library ? await loadLibraryModule(config.library) : undefined;
  const overrides = config.overrides ? await loadOverridesModule(config.overrides) : undefined;
  const iconLoader = iconLoaderFrom(config.icons);

  return {
    library: custom?.library ?? stockLibrary,
    ...(custom ? { normalizers: custom.normalizers } : {}),
    ...(overrides ? { overrides } : {}),
    ...(iconLoader ? { iconLoader } : {}),
    onUnknownIcon: config.icons.onUnknown,
  };
}

export async function rendererOptionsFrom(
  config: EffectiveConfig,
  chromiumPath: string,
): Promise<RendererOptions> {
  const setup = await resolverSetupFrom(config);

  return {
    ...setup,
    chromiumPath,
    pages: config.pages,
    deviceScaleFactor: config.deviceScaleFactor,
    ...(config.fonts ? { fonts: config.fonts } : {}),
  };
}
