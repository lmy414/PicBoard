/** Responsive shell breakpoints (logical px) and the pure bucket functions. */

export const SIDEBAR_DOCK_MIN_WINDOW = 1100;
/** Docked sidebar width; overlay mode rides at width 0 and gives it back. */
export const SIDEBAR_WIDTH = 248;
export const DRAWER_WIDTH = 300;
export const DRAWER_MIN_CANVAS = 480;
export const MINIMAP_MIN_CANVAS = 560;
export const TOPBAR_COMPACT_MAX_WINDOW = 900;

export type SidebarLayout = "docked" | "overlay";
export type DrawerLayout = "docked" | "overlay";
export type TopbarLayout = "full" | "compact";
export type MinimapBucket = "wide" | "narrow";

const finiteWidth = (width: number, fallback: number): number => (Number.isFinite(width) ? width : fallback);

/** The sidebar docks beside the workspace on wide windows; below it rides the rail as an overlay. */
export function sidebarLayout(windowWidth: number): SidebarLayout {
  return finiteWidth(windowWidth, SIDEBAR_DOCK_MIN_WINDOW) >= SIDEBAR_DOCK_MIN_WINDOW ? "docked" : "overlay";
}

/**
 * The history drawer docks only while the canvas keeps its usable width with
 * the drawer beside it; otherwise it opens as an overlay sheet.
 */
export function drawerLayout(mainWidth: number): DrawerLayout {
  return finiteWidth(mainWidth, Number.MAX_SAFE_INTEGER) - DRAWER_WIDTH >= DRAWER_MIN_CANVAS ? "docked" : "overlay";
}

/** The minimap only pays for itself once the canvas is wide enough. */
export function minimapBucket(canvasWidth: number): MinimapBucket {
  return finiteWidth(canvasWidth, Number.MAX_SAFE_INTEGER) >= MINIMAP_MIN_CANVAS ? "wide" : "narrow";
}

/** Secondary top-bar buttons collapse into an overflow menu on narrow windows. */
export function topbarLayout(windowWidth: number): TopbarLayout {
  return finiteWidth(windowWidth, Number.MAX_SAFE_INTEGER) > TOPBAR_COMPACT_MAX_WINDOW ? "full" : "compact";
}
