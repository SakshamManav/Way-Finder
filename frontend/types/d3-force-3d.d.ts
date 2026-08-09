declare module "d3-force-3d" {
  export interface Force {
    (alpha: number): void;
    initialize?(nodes: unknown[]): void;
    strength(): number;
    strength(value: number): Force;
    radius(): (node: unknown) => number;
    radius(value: (node: unknown) => number): Force;
    iterations(): number;
    iterations(value: number): Force;
    distanceMax(): number;
    distanceMax(value: number): Force;
  }
  export function forceCollide(): Force;
  export function forceManyBody(): Force;
}
