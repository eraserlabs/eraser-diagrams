import type { JsonSchema } from '@eraserlabs/resolve/schema';
import {
  ShapeStyleProps,
  WashTexProps,
  BadgeProperties,
  GroupTitle,
  GroupTitleBand,
  ICON_SIZE_PRESETS,
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

export const DatabaseField: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: PlainText,
    type: PlainText,
    meta: PlainText,
  },
};

/** Group, Lane, Pool share one HTML template but are distinct registry entries. */
export const groupLike: Record<string, JsonSchema> = {
  title: GroupTitle,
  ...ShapeStyleProps,
  ...WashTexProps,
  badge: BadgeProperties,
};

/** Lane/Pool variant: the side title defaults to the full-height BPMN band. */
export const bandGroupLike: Record<string, JsonSchema> = {
  ...groupLike,
  title: GroupTitleBand,
};
