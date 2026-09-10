export type Rect = { x: number; y: number; width: number; height: number }
/** The smallest area the native capture will accept, in points. */
export const MINIMUM_REGION = 16

/** Keeps a drawn region on screen and large enough to be worth capturing. */
export function containRegion(rect: Rect, view: { width: number; height: number }): Rect {
  const width = Math.max(MINIMUM_REGION, Math.min(Math.round(rect.width), view.width))
  const height = Math.max(MINIMUM_REGION, Math.min(Math.round(rect.height), view.height))
  return {
    width,
    height,
    x: Math.max(0, Math.min(Math.round(rect.x), view.width - width)),
    y: Math.max(0, Math.min(Math.round(rect.y), view.height - height)),
  }
}
