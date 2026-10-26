import {
  entitySchema,
  MarkdownTextProperties,
  BadgeProperties,
  PaletteColor,
  CssColor,
  FontSizePx,
  BORDER_STYLES,
  TYPEFACES,
} from '../../schema/index.js';
import { IconName } from '../_shared/schema-parts.js';

export const Event = entitySchema(
  'Event',
  {
    texts: { type: 'array', items: MarkdownTextProperties },
    icon: IconName,
    color: PaletteColor,
    bgColor: CssColor,
    borderColor: CssColor,
    borderStyle: { type: 'string', enum: [...BORDER_STYLES] },
    fontSize: FontSizePx,
    typeface: { type: 'string', enum: [...TYPEFACES] },
    badge: BadgeProperties,
  },
  { required: ['x', 'y'] },
);
