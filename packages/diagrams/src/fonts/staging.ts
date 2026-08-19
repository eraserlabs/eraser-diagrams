import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  planFontStaging,
  buildFontsHead,
  type FontsConfig,
  type FontSource,
} from '@eraserlabs/resolve';

export type StagedByteSource = Extract<FontSource, { kind: 'file' | 'file-from-url' }>;

/** One face resolved to bytes in Node, ready for `document.fonts.add(new FontFace(...))`. */
export interface StagedFontFace {
  family: string;
  bytes: Uint8Array;
  weight?: string;
  style?: string;
  /** Original `file` / `file-from-url` source — HTML output needs kind, path/url, and `inline`. */
  source?: StagedByteSource;
}

export interface StagedFonts {
  /** Byte-backed faces for page injection (`file` / `file-from-url`). `url` faces are not listed. */
  faces: StagedFontFace[];
  /** Role-var CSS plus `@font-face` rules for `url` faces. */
  css: string;
  /** Families whose `file` / `file-from-url` faces failed to stage. `url` faces are never listed. */
  degraded: string[];
  /** Config with failed `file` / `file-from-url` faces dropped — `url` faces always survive. */
  config: FontsConfig;
}

/**
 * Resolve `file` and `file-from-url` faces to bytes in Node for page `FontFace` injection.
 * `file-from-url` is fetched once into its disk cache (reused across boots) then read. `url`
 * faces are not fetched — they become `@font-face` rules in `css` and the browser loads them.
 * On `file` / `file-from-url` failure honor `throwOnFontFail`: throw, or drop the face and
 * report the family as degraded. `url` faces are never listed as degraded.
 */
export async function stageFonts(config: FontsConfig): Promise<StagedFonts> {
  const plan = planFontStaging(config);
  const degraded: string[] = [];
  const failedPaths = new Set<string>();

  for (const { family, url, cachePath } of plan.fetches) {
    try {
      if (!(await exists(cachePath))) {
        await mkdir(dirname(cachePath), { recursive: true });
        await writeFile(cachePath, await fetchBytes(family, url));
      }
    } catch (err) {
      if (config.throwOnFontFail) {
        throw err instanceof Error ? err : new Error(String(err));
      }

      degraded.push(family);
      failedPaths.add(cachePath);
    }
  }

  const faces: StagedFontFace[] = [];
  const okFaces: FontsConfig['faces'] = [];

  for (const face of config.faces) {
    if (face.kind === 'system' || face.kind === 'url') {
      okFaces.push(face);
      continue;
    }

    if (face.kind === 'file-from-url' && failedPaths.has(face.cachePath)) {
      continue;
    }

    try {
      const path = face.kind === 'file' ? face.path : face.cachePath;
      const staged: StagedFontFace = {
        family: face.family,
        bytes: new Uint8Array(await readFile(path)),
        source: face,
      };

      if (face.weight) {
        staged.weight = face.weight;
      }

      if (face.style) {
        staged.style = face.style;
      }

      faces.push(staged);
      okFaces.push(face);
    } catch (err) {
      if (config.throwOnFontFail) {
        throw err instanceof Error ? err : new Error(String(err));
      }

      degraded.push(face.family);
    }
  }

  const finalConfig: FontsConfig = { ...config, faces: okFaces };

  return { faces, css: buildFontsHead(finalConfig), degraded, config: finalConfig };
}

async function fetchBytes(family: string, url: string): Promise<Uint8Array> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`font "${family}" fetch failed: ${response.status} ${url}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}
