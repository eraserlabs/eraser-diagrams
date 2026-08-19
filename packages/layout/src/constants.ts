import { LayoutOptions } from './types.js';

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
