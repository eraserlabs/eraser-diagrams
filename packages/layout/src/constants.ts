import { LayoutOptions } from './types.js';

/** Sub-pixel spread that still counts as one shared edge, gap, or wall. */
export const GEOMETRY_EPSILON = 0.5;

/** Geometry noise floor: a smaller delta is not a change worth emitting. */
export const OUTPUT_EPSILON = 1e-9;

export const DEFAULT_OPTIONS: LayoutOptions = {
  marginBetweenEntities: 40,
  marginBetweenRanks: 40,
  containerPadding: {
    top: 20,
    right: 20,
    bottom: 20,
    left: 20,
  },
  minConnectionLength: 80,
  minConnectionTextMargin: 40,
  sizingMode: 'auto',
  entityRankSpacing: undefined,
};
