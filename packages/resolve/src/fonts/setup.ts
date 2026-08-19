import type { FontsConfig } from '@eraserlabs/protocol';

/** One URL the caller must fetch and cache before render. */
export interface FontFetch {
  family: string;
  url: string;
  cachePath: string;
}

export interface FontStagingPlan {
  /** `file-from-url` faces the caller must fetch and cache before render. */
  fetches: FontFetch[];
  /** Same config with each `file-from-url` face rewritten to a `file` face at its cachePath. */
  config: FontsConfig;
}

/**
 * Pure staging plan. Resolve never touches network or disk — it tells the caller (the server)
 * which font URLs to cache where, and hands back a config that assumes the caching happened.
 */
export function planFontStaging(config: FontsConfig): FontStagingPlan {
  const fetches: FontFetch[] = [];
  const faces = [];

  for (const face of config.faces) {
    if (face.kind !== 'file-from-url') {
      faces.push(face);
      continue;
    }

    fetches.push({ family: face.family, url: face.url, cachePath: face.cachePath });
    faces.push({
      kind: 'file' as const,
      family: face.family,
      path: face.cachePath,
      ...pick(face),
    });
  }

  return { fetches, config: { ...config, faces } };
}

function pick(face: { weight?: string; style?: string; format?: string; inline?: boolean }): {
  weight?: string;
  style?: string;
  format?: string;
  inline?: boolean;
} {
  const out: { weight?: string; style?: string; format?: string; inline?: boolean } = {};

  if (face.weight) {
    out.weight = face.weight;
  }

  if (face.style) {
    out.style = face.style;
  }

  if (face.format) {
    out.format = face.format;
  }

  if (face.inline) {
    out.inline = true;
  }

  return out;
}
