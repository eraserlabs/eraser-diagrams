import { CssColor } from '@eraserlabs/resolve/schema';
import {
  entitySchema,
  ShapeStyleProps,
  WashTexProps,
  BadgeProperties,
  FontSizePx,
  H_ALIGNS,
  TYPEFACES,
} from '../../schema/index.js';
import { IconName, PlainText, DatabaseField } from '../_shared/schema-parts.js';

export const DatabaseTable = entitySchema(
  'DatabaseTable',
  {
    label: PlainText,
    icon: IconName,
    fields: { type: 'array', items: DatabaseField },
    fontSize: FontSizePx,
    typeface: { type: 'string', enum: [...TYPEFACES] },
    /** Header band paint; absent keeps the constant white band. */
    titleBgColor: CssColor,
    /** Table-name alignment within the header band. */
    hAlign: { type: 'string', enum: [...H_ALIGNS], default: 'left' },
    ...ShapeStyleProps,
    ...WashTexProps,
    badge: BadgeProperties,
  },
  { required: ['x', 'y'] },
);
