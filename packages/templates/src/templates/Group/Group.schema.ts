import { entitySchema } from '../../schema/index.js';
import { groupLike } from '../_shared/schema-parts.js';

export const Group = entitySchema('Group', groupLike, { required: ['x', 'y'], isContainer: true });
