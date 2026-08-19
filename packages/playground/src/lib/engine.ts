import {
  createResolver,
  prepareLibrary,
  type IconLoader,
  type Resolver,
} from '@eraserlabs/resolve';
// Deep imports: the package root re-exports the Chromium conductor, which cannot enter a browser
// bundle. The normalizer table and library data are pure derivation + data.
import { stockNormalizers } from '@eraserlabs/diagrams/normalizers';
import { normalizeFetchedIcon } from '@eraserlabs/diagrams/svg-transforms';
import { buildRenderPageSetup, stockLibrary } from '@eraserlabs/diagrams/library';

// The public bucket has no CORS config, so the browser cannot fetch it cross-origin — the dev
// server proxies /icon-assets to it (vite.config.ts). Same store the product and docs use.
const iconLoader: IconLoader = async (name) => {
  const response = await fetch(`/icon-assets/${name}.svg`, {
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`icon "${name}": HTTP ${response.status}`);
  }

  // Brand assets are raw (style-class palettes, no viewBox) — normalize in-flight, exactly like
  // the Node loader.
  return normalizeFetchedIcon(await response.text(), name);
};

// The playground runs the resolve engine in the browser against the library imported straight
// from source (vite aliases @eraserlabs/* to src in dev) — the same data path the orchestrator uses,
// minus Chromium, and edits to templates or normalizers HMR in. The normalizer table is part of
// that path: without it templates miss every derived prop (washPath, outline, sizePx, …).
let resolverPromise: Promise<Resolver> | undefined;

export function getResolver(): Promise<Resolver> {
  resolverPromise ??= createResolver({
    library: stockLibrary,
    iconLoader,
    normalizers: stockNormalizers,
  });

  return resolverPromise;
}

/** The page-lifetime setup the render preview posts into its iframe. */
export const pageSetup = buildRenderPageSetup(prepareLibrary(stockLibrary));
