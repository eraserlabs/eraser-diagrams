# @eraserlabs/utils

## Introduction

`@eraserlabs/utils` is a dependency-free helper package shared by the other Eraser packages. It exports a `TimeTracker` for named phase timings, `addToSet` for mutating set membership, and the `isFiniteNumber` / `isRecord` type guards.

## Usage

```ts
import {
  TimeTracker,
  addToSet,
  isFiniteNumber,
  isRecord,
} from '@eraserlabs/utils';

const tracker = new TimeTracker();
tracker.mark('resolve');
tracker.mark('render');
const ms = tracker.timings;
```
