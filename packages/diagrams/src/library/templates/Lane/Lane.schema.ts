import { entitySchema } from '../../schema/index.js';
import { bandGroupLike } from '../_shared/schema-parts.js';

export const Lane = entitySchema('Lane', bandGroupLike, {
  required: ['x', 'y'],
  isContainer: true,
});
