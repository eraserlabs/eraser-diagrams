export type Point = [number, number];

/** Which endpoint of a connection is being considered. */
export type EndpointSide = 'from' | 'to';

export type CornerPortPosition = [0, 0] | [0, 1] | [1, 0] | [1, 1];
export type RelativePortPosition = CornerPortPosition | [number, number];
