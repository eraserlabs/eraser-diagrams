import { CssColor, type JsonSchema } from '@eraserlabs/resolve/schema';
import {
  entitySchema,
  ShapeStyleProps,
  WashTexProps,
  BadgeProperties,
  FontSizePx,
  H_ALIGNS,
  TYPEFACES,
} from '../../schema/index.js';
import { IconName, PlainText, type TableField, TableFieldSchema } from '../_shared/schema-parts.js';

export interface ClassSection {
  /** Optional compartment heading. An unnamed compartment starts with a divider. */
  name?: string;
  items: TableField[];
}

const sectionProperties: Record<keyof ClassSection, JsonSchema> = {
  name: PlainText,
  items: { type: 'array', items: TableFieldSchema },
};

const classSectionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: sectionProperties,
};

export const ClassBox = entitySchema(
  'ClassBox',
  {
    label: PlainText,
    /** Optional UML stereotype shown above the class name (bare strings auto-wrap as `«…»`). */
    stereotype: PlainText,
    /** Italicize the class name (UML abstract class). */
    italic: { type: 'boolean' },
    icon: IconName,
    /** Ordered compartments (named or unnamed) such as attributes, methods, and events. */
    sections: { type: 'array', items: classSectionSchema },
    fontSize: FontSizePx,
    typeface: { type: 'string', enum: [...TYPEFACES] },
    /** Header band paint; absent keeps the surface band. */
    titleBgColor: CssColor,
    /** Class-name alignment within the header band; defaults to centered (UML convention). */
    hAlign: { type: 'string', enum: [...H_ALIGNS], default: 'center' },
    ...ShapeStyleProps,
    ...WashTexProps,
    badge: BadgeProperties,
  },
  { required: ['x', 'y'] },
);
