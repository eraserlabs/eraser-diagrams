import { CssColor, type JsonSchema } from '@eraserlabs/resolve/schema';
import { BADGE_SHAPES, BADGE_PLACEMENTS } from '../../schema/enums.js';
import { FontSizePx } from '../../schema/text.js';

/** Badge contract; hosts compose this into their tag schemas. */
export const Badge: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', 'x-content': 'inline-markdown' },
    icon: { type: 'string', 'x-icon-name': true },
    /** Literal glyph size in pixels, independent of the badge text. */
    iconSize: { type: 'number', minimum: 0 },
    iconColor: CssColor,
    color: CssColor,
    bgColor: CssColor,
    fontSize: FontSizePx,
    shape: { type: 'string', enum: [...BADGE_SHAPES] },
    padding: { type: 'number' },
    placement: { type: 'string', enum: [...BADGE_PLACEMENTS] },
  },
};
