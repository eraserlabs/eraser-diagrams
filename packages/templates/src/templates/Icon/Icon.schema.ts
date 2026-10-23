import {
  entitySchema,
  MarkdownTextProperties,
  BadgeProperties,
  FontSizePx,
  CssColor,
  TYPEFACES,
} from '../../schema/index.js';
import type { JsonSchema } from '@eraserlabs/resolve/schema';
import { IconName, IconSize } from '../_shared/schema-parts.js';

/**
 * A caption run: a text run plus the wrap width a host's fit chose for it (fitElement's
 * externalRuns), drawn as saved so rendering never re-runs the sizing.
 */
const IconTextProperties: JsonSchema = {
  ...MarkdownTextProperties,
  properties: {
    ...MarkdownTextProperties.properties,
    wrapWidth: { type: 'number', minimum: 1 },
  },
};

export const Icon = entitySchema(
  'Icon',
  {
    icon: IconName,
    size: IconSize,
    texts: { type: 'array', items: IconTextProperties },
    typeface: { type: 'string', enum: [...TYPEFACES] },
    color: CssColor,
    fontSize: FontSizePx,
    badge: BadgeProperties,
    /** Derived (normalizers.ts): the authored bounds, when there are any — see IconSize. */
    sizePx: { type: 'number' },
  },
  { required: ['x', 'y'] },
);
