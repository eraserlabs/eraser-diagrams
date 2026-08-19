import { LayoutManager } from '../LayoutManager.js';
import { entityContainsRange } from '../sizeUtils.js';
import { LayoutEntity } from '../types.js';

describe('entityContainsRange', () => {
  const container: LayoutEntity = {
    id: 'container',
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    isContainer: true,
    options: {
      containerPadding: { top: 20, right: 20, bottom: 20, left: 20 },
    },
  };

  const layoutManager = new LayoutManager({
    entities: [container],
    connections: [],
  });

  it('requires ranges to stay above the bottom padding boundary', () => {
    expect(
      entityContainsRange(
        layoutManager,
        container,
        { minX: 20, minY: 20, maxX: 180, maxY: 180 },
        true,
      ),
    ).toBe(true);

    expect(
      entityContainsRange(
        layoutManager,
        container,
        { minX: 20, minY: 20, maxX: 180, maxY: 181 },
        true,
      ),
    ).toBe(false);
  });
});
