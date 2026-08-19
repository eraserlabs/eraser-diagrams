export const LABEL_LINE_CLEARANCE_PX = 4;
export const LABEL_JOG_MARGIN_PX = 16;

export interface LabelSize {
  readonly width: number;
  readonly height: number;
}

/** One measured label. A route can own at most one label. */
export interface LabelSpec {
  readonly routeIndex: number;
  readonly size: LabelSize;
}
