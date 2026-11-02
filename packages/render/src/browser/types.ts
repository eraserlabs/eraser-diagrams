import type { RepairPolicy } from '@eraserlabs/layout';
import type { ResolvedConnection, ResolvedEntity, Theme } from '@eraserlabs/protocol';

/** Page-lifetime configuration: injected once per page by the orchestrator, reused per request. */
export interface PageSetup {
  /** Template name → template file HTML and its bare-selector CSS. */
  templates: Record<string, { html: string; css: string }>;
  /** Shared CSS applied before per-template rules (unscoped). */
  baseCss: string;
  /** Grayscale watercolor master (data URI) — tinted per pigment pair before fill (masters.ts). */
  washMaster?: string;
}

/**
 * The per-request payload. The lists arrive already split: kind is a per-tag fact the resolver
 * read off `x-schema-kind`, so nothing in the browser re-derives it.
 */
export interface RunRequest {
  /** Scene presentation; normally inherited from resolved elements. Useful for an empty scene. */
  theme?: Theme;
  entities: ResolvedEntity[];
  connections: ResolvedConnection[];
  /** Icon name → sanitized SVG sidecar. */
  icons: Record<string, string>;
  /**
   * How long layout may spend repairing routes. Absent means no limit, so the same request always
   * routes the same way; an interactive caller can pass a budget such as `{ timeBudgetMs: 100 }`.
   */
  repair?: RepairPolicy;
}
