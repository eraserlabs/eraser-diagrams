import { entitySchema } from '../../schema/index.js';
import { bandGroupLike } from '../_shared/schema-parts.js';

export const Pool = entitySchema('Pool', bandGroupLike, {
  required: ['x', 'y'],
  isContainer: true,
});
