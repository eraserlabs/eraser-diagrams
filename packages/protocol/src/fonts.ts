/** A font source understood by the resolve/orchestration boundary. */
export type FontSource =
  | {
      /**
       * Host-installed family. No `@font-face` rule. Metrics may differ across machines.
       */
      kind: 'system';
      family: string;
    }
  | {
      /**
       * Read from disk for measurement and PNG. HTML output references
       * `url('file:///<absolute path>')` unless `inline` is true — non-portable by design.
       */
      kind: 'file';
      family: string;
      path: string;
      weight?: string;
      style?: string;
      format?: string;
      /**
       * When true, HTML output embeds this face as a base64 data URI. Default false.
       * Does not affect rendering — measurement and PNG always use disk bytes.
       */
      inline?: boolean;
    }
  | {
      /**
       * Fetched once into `cachePath`, then rendering behaves as `file`. HTML output
       * references the original `url` unless `inline` is true. The cache is a render-side
       * optimization; the font's identity is its URL.
       */
      kind: 'file-from-url';
      family: string;
      url: string;
      cachePath: string;
      weight?: string;
      style?: string;
      format?: string;
      /**
       * When true, HTML output embeds this face as a base64 data URI. Default false.
       * Does not affect rendering — measurement and PNG always use the cached bytes.
       */
      inline?: boolean;
    }
  | {
      /**
       * Loaded by the browser at render time from an absolute `http(s)://` URL. Requires
       * network. HTML output references the same URL. There is no `inline` flag — inlining
       * a remote font is `file-from-url` + `inline`.
       */
      kind: 'url';
      family: string;
      url: string;
      weight?: string;
      style?: string;
      format?: string;
    };

/** Role names are profile-defined; templates consume matching `--font-<role>` variables. */
export type FontRoles = Record<string, string>;

export interface FontsConfig {
  roles: FontRoles;
  faces: FontSource[];
  /**
   * When true, a `file` or `file-from-url` face that fails to read or fetch throws at staging.
   * Does not apply to `url` faces: the browser owns those failures and the role-var fallback
   * applies.
   */
  throwOnFontFail?: boolean;
  /** Generic-family fallbacks appended to each role variable. */
  fallbacks?: Partial<FontRoles>;
}
