# Third-party notices

`@eraserlabs/layout` contains source adapted from the following projects. Eraser's modifications are distributed under the package's MIT license; the original copyright and license notices remain in force for their respective portions.

## RBush 4.0.1

- Project: [RBush](https://github.com/mourner/rbush/tree/v4.0.1)
- Copyright: Copyright (c) 2016 Vladimir Agafonkin
- License: MIT; see `licenses/rbush-MIT.txt`
- Incorporated into: `src/rtree/RTree.ts`, emitted as `dist/rtree/RTree.js`

The implementation was ported from JavaScript to TypeScript and adapted to use layout's native `{ x, y, width, height }` items. It also adds allocation-light visitor, scalar-bound, and early-exit query APIs and removes RBush's `toBBox` and item-comparator extension points.

## Quickselect 3.0.0

- Project: [Quickselect](https://github.com/mourner/quickselect/tree/v3.0.0)
- Copyright: Copyright (c) 2018, Vladimir Agafonkin
- License: ISC; see `licenses/quickselect-ISC.txt`
- Incorporated into: the bulk-loading selection routine in `src/rtree/RTree.ts`, emitted as part of `dist/rtree/RTree.js`

The selection routine was inlined and adapted to typed TypeScript so `@eraserlabs/layout` does not require a runtime Quickselect dependency.
