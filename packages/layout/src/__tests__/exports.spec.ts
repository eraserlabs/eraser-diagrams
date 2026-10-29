import * as layout from '../index.js';

describe('layout package exports', () => {
  it('exports the routing, editing and geometry API from the root', () => {
    for (const name of [
      'routeConnections',
      'isDirectConnection',
      'getArcPathD',
      'getArcPolyline',
      'getArcApex',
      'defaultBendForChord',
      'isArcBend',
      'ARC_BEND_SNAP_THRESHOLD',
      'COMMIT_REPAIR',
      'anchorFromStored',
      'resolveManualLabel',
      'LayoutManager',
      'generateChanges',
      'generateChangesForMove',
      'makeRoomForEntities',
      'getPositionForEntity',
      'intersectRanges',
      'makeRangeFromEntity',
      'createEntityOutline',
      'roundedCornerGeometry',
      'GUIDELINE_NAME',
    ]) {
      expect(layout, name).toHaveProperty(name);
    }
  });

  it('no longer exports the 0.4 batch adapter or straight endpoints', () => {
    expect(layout).not.toHaveProperty('routeCorridorConnectionBatch');
    expect(layout).not.toHaveProperty('straightConnectionEndpoints');
  });

  it('defines the caller-facing guideline names itself', () => {
    expect(layout.GUIDELINE_NAME).toEqual(['h0', 'h1', 'h2', 'v0', 'v1', 'v2', 'hfp', 'vfp']);
  });
});
