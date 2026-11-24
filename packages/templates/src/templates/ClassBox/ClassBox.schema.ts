import { CssColor, type JsonSchema } from '@eraserlabs/resolve/schema';
import {
  entitySchema,
  ShapeStyleProps,
  WashTexProps,
  BadgeProperties,
  FontSizePx,
  UnderlineStyle,
  H_ALIGNS,
  TYPEFACES,
} from '../../schema/index.js';
import { IconName, PlainText } from '../_shared/schema-parts.js';

export const ClassMember: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: PlainText,
    type: PlainText,
    meta: PlainText,
    italic: { type: 'boolean' },
    underline: UnderlineStyle,
  },
};

export const ClassSection: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    /** Optional compartment label (e.g. "attributes", "methods", "events"). Omitted = divider-only compartment. */
    name: PlainText,
    items: { type: 'array', items: ClassMember },
  },
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
    sections: { type: 'array', items: ClassSection },
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
