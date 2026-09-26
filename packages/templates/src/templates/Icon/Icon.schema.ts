import {
  entitySchema,
  MarkdownTextProperties,
  BadgeProperties,
  FontSizePx,
  CssColor,
  TYPEFACES,
} from '../../schema/index.js';
import { IconName, IconSize } from '../_shared/schema-parts.js';

export const Icon = entitySchema(
  'Icon',
  {
    icon: IconName,
    size: IconSize,
    texts: { type: 'array', items: MarkdownTextProperties },
    typeface: { type: 'string', enum: [...TYPEFACES] },
    color: CssColor,
    fontSize: FontSizePx,
    badge: BadgeProperties,
    /** Derived (normalizers.ts): the authored bounds, when there are any — see IconSize. */
    sizePx: { type: 'number' },
  },
  { required: ['x', 'y'] },
);
