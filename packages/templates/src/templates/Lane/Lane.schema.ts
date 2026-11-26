import { ShapeStyleProps } from '../../schema/components.js';
import { entitySchema } from '../../schema/index.js';
import { bandGroupLike } from '../_shared/schema-parts.js';

export const Lane = entitySchema(
  'Lane',
  {
    ...bandGroupLike,
    styleMode: { ...ShapeStyleProps['styleMode'], default: 'plain' },
  },
  { required: ['x', 'y'], isContainer: true },
);
