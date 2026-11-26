import type { JsonSchema } from '@eraserlabs/resolve/schema';
import {
  ShapeStyleProps,
  WashTexProps,
  BadgeProperties,
  GroupTitle,
  GroupTitleBand,
  ICON_SIZE_PRESETS,
  ORIENTATIONS,
  UnderlineStyle,
} from '../../schema/index.js';

/** Shared prop fragments reused across per-tag schema modules. */

export const IconName: JsonSchema = { type: 'string', 'x-icon-name': true };

/**
 * Semantic icon size token. Host CSS maps it to px; authored `width` / `height` win via
 * bounds-first precedence.
 */
export const IconSize: JsonSchema = { type: 'string', enum: [...ICON_SIZE_PRESETS] };
export const PlainText: JsonSchema = { type: 'string', 'x-content': 'plain' };
export const MarkdownText: JsonSchema = { type: 'string', 'x-content': 'markdown' };

/** A row in a database table or a member of a UML class section. */
export interface TableField {
  name: string;
  type?: string;
  meta?: string;
  italic?: boolean;
  underline?: UnderlineStyle;
}

export const TableFieldSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: PlainText,
    type: PlainText,
    meta: PlainText,
    italic: { type: 'boolean' },
    underline: UnderlineStyle,
  } satisfies Record<keyof TableField, JsonSchema>,
};

export const cornerRadiiProps: Record<string, JsonSchema> = {
  cornerTL: { type: 'number' },
  cornerTR: { type: 'number' },
  cornerBR: { type: 'number' },
  cornerBL: { type: 'number' },
};

/** Group, Lane, Pool share one HTML template but are distinct registry entries. */
export const groupLike: Record<string, JsonSchema> = {
  title: GroupTitle,
  ...cornerRadiiProps,
  customBorder: { type: 'boolean' },
  ...ShapeStyleProps,
  ...WashTexProps,
  badge: BadgeProperties,
};

/**
 * Lane/Pool variant: defaults to the left-edge horizontal-swimlane band;
 * `orientation: 'vertical'` places the band horizontally along the top edge.
 */
export const bandGroupLike: Record<string, JsonSchema> = {
  ...groupLike,
  title: GroupTitleBand,
  orientation: { type: 'string', enum: [...ORIENTATIONS] },
};
