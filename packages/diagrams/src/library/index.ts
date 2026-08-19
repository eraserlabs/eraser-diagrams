import type { TemplateFile } from '@eraserlabs/protocol';
import type { AuthoredLibrary } from '@eraserlabs/resolve';
import type { JsonSchema } from '@eraserlabs/resolve/schema';
import { BASE_CSS, TEMPLATE_HTML, TEMPLATE_CSS } from './generated/templates.gen.js';
import { name as ShapeName, schema as Shape } from './templates/Shape/index.js';
import { name as IconName, schema as Icon } from './templates/Icon/index.js';
import { name as ActivityName, schema as Activity } from './templates/Activity/index.js';
import { name as EventName, schema as Event } from './templates/Event/index.js';
import { name as GatewayName, schema as Gateway } from './templates/Gateway/index.js';
import { name as TextboxName, schema as Textbox } from './templates/Textbox/index.js';
import { name as GroupName, schema as Group } from './templates/Group/index.js';
import { name as LaneName, schema as Lane } from './templates/Lane/index.js';
import { name as PoolName, schema as Pool } from './templates/Pool/index.js';
import { name as DividerName, schema as Divider } from './templates/Divider/index.js';
import {
  name as DatabaseTableName,
  schema as DatabaseTable,
} from './templates/DatabaseTable/index.js';
import { name as LegendName, schema as Legend } from './templates/Legend/index.js';
import {
  name as RelationshipName,
  schema as Relationship,
} from './templates/Relationship/index.js';
import {
  name as DatabaseRelationshipName,
  schema as DatabaseRelationship,
} from './templates/DatabaseRelationship/index.js';
import { name as BadgeName, schema as Badge } from './templates/Badge/index.js';
import { STOCK_PALETTE } from './schema/palette.js';

/**
 * Stock templates as data. Markup is declarative and unfilled: `{{ }}` placeholders and `data-*`
 * directives are left verbatim for the downstream fill stage. Connection templates carry an SVG
 * `<path>` whose `d` is an unfilled placeholder for eraser-layout (see SPEC clause 5).
 */

/** Emission order (manifest order = cascade + template-definition order). */
export const MANIFEST: readonly string[] = [
  ShapeName,
  IconName,
  ActivityName,
  EventName,
  GatewayName,
  TextboxName,
  GroupName,
  LaneName,
  PoolName,
  DividerName,
  DatabaseTableName,
  LegendName,
  RelationshipName,
  DatabaseRelationshipName,
  BadgeName,
] as const;

export { BASE_CSS };

function getTemplate(name: string): TemplateFile {
  const html = TEMPLATE_HTML[name];
  const css = TEMPLATE_CSS[name];

  if (html === undefined || css === undefined) {
    throw new Error(`Missing generated template markup for ${name}`);
  }

  return { name, html, css };
}

export const stockTemplates: TemplateFile[] = MANIFEST.map(getTemplate);

/** Dispatchable per-tag schemas (Badge is a nested sub-template, not an input tag). */
export const tagSchemas: Record<string, JsonSchema> = {
  Icon,
  Shape,
  Activity,
  Event,
  Gateway,
  DatabaseTable,
  Textbox,
  Group,
  Lane,
  Pool,
  Divider,
  Legend,
  Relationship,
  DatabaseRelationship,
};

/**
 * Sub-templates are not entity elements (exempt from the one-body rule) and are never dispatch
 * targets — but each carries its own schema, which hosts compose and the linter derives
 * placeholder/content rules from.
 */
export const subTemplateSchemas: Record<string, JsonSchema> = {
  [BadgeName]: Badge,
};

/** Allowed placeholder head names per template, derived from each template's own schema. */
export const templateProps: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};

  for (const [name, schema] of Object.entries({ ...tagSchemas, ...subTemplateSchemas })) {
    map[name] = Object.keys(schema.properties ?? {});
  }

  return map;
})();

/** The stock library as data — schemas, markup, CSS, palette, and manifest order. */
export const stockLibrary: AuthoredLibrary = {
  manifest: MANIFEST,
  schemas: tagSchemas,
  templates: stockTemplates,
  baseCss: BASE_CSS,
  subTemplates: subTemplateSchemas,
  // A tag-less connection in the split form is a Relationship — the everyday edge.
  defaultConnectionTag: RelationshipName,
  palette: STOCK_PALETTE,
};

export { STOCK_PALETTE, STOCK_PALETTE_TOKENS } from './schema/palette.js';

// Browser-safe page-setup builder, re-exported so browser consumers (the playground) can reach
// it through the "./library" subpath without touching the package root's Chromium conductor.
export { buildRenderPageSetup } from './pageSetup.js';
