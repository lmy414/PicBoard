//! Window geometry helpers: the main desktop window's bounds and the tray
//! flyout panel's anchoring.
//!
//! All values are logical (CSS) pixels; Windows host calls operate in physical
//! pixels, so the controller converts at the boundary using the window or
//! monitor scale factor.

/// Physical-pixel rectangle used for monitor work areas and window bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub fn right(&self) -> i32 {
        self.x + self.width
    }

    pub fn bottom(&self) -> i32 {
        self.y + self.height
    }
}

/// Minimum logical size of the main window (resizable desktop mode).
pub const MAIN_MIN_WIDTH: i32 = 720;
pub const MAIN_MIN_HEIGHT: i32 = 480;
/// Logical size of the tray flyout panel (fixed, not resizable).
pub const TRAY_PANEL_WIDTH: i32 = 420;
pub const TRAY_PANEL_HEIGHT: i32 = 600;
/// Gap between the tray panel and the taskbar edge / tray icon.
const PANEL_GAP: i32 = 8;

/// Size of a first-use main window: ~78% of the work-area width and ~85% of
/// its height (floored at 960x640 so the canvas + tree sidebar layout stays
/// usable, never larger than the work area).
fn main_size_for(work_area: Rect) -> (i32, i32) {
    let available_width = work_area.width.max(1);
    let available_height = work_area.height.max(1);
    let width = work_area
        .width
        .saturating_sub(24)
        .min(work_area.width * 78 / 100)
        .max(960)
        .min(available_width);
    let height = work_area
        .height
        .saturating_sub(24)
        .min(work_area.height * 85 / 100)
        .max(640)
        .min(available_height);
    (width, height)
}

/// Position a rect so it is fully inside `work_area` (positions clamp before
/// sizes overflow a smaller-than-window work area).
fn clamp_position(rect: &mut Rect, work_area: Rect) {
    let max_x = work_area
        .x
        .max(work_area.right().saturating_sub(rect.width));
    let max_y = work_area
        .y
        .max(work_area.bottom().saturating_sub(rect.height));
    rect.x = rect.x.clamp(work_area.x, max_x);
    rect.y = rect.y.clamp(work_area.y, max_y);
}

/// Bounds for the main window at startup/expansion: the user's previously
/// chosen bounds (clamped into the current work area, never below the minimum)
/// or a centered work-area fit for first use.
pub fn fit_main_window(saved: Option<Rect>, work_area: Rect) -> Rect {
    let Some(saved) = saved else {
        let (width, height) = main_size_for(work_area);
        let mut bounds = Rect {
            x: work_area.x + work_area.width.saturating_sub(width) / 2,
            y: work_area.y + work_area.height.saturating_sub(height) / 2,
            width,
            height,
        };
        clamp_position(&mut bounds, work_area);
        return bounds;
    };
    let available_width = work_area.width.max(1);
    let available_height = work_area.height.max(1);
    let mut restored = Rect {
        width: saved
            .width
            .clamp(MAIN_MIN_WIDTH.min(available_width), available_width),
        height: saved
            .height
            .clamp(MAIN_MIN_HEIGHT.min(available_height), available_height),
        x: saved.x,
        y: saved.y,
    };
    clamp_position(&mut restored, work_area);
    restored
}

/// Which work-area border the taskbar sits on, inferred from the clicked tray
/// icon's rect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskbarEdge {
    Bottom,
    Top,
    Left,
    Right,
}

pub fn detect_taskbar_edge(tray_icon: Rect, work_area: Rect) -> TaskbarEdge {
    if tray_icon.y >= work_area.bottom() {
        TaskbarEdge::Bottom
    } else if tray_icon.bottom() <= work_area.y {
        TaskbarEdge::Top
    } else if tray_icon.right() >= work_area.right() {
        TaskbarEdge::Right
    } else if tray_icon.x <= work_area.x {
        TaskbarEdge::Left
    } else {
        // Ambiguous (e.g. a shell quirk): the bottom taskbar is the norm.
        TaskbarEdge::Bottom
    }
}

/// Anchor the tray flyout panel next to the clicked tray icon: above it on a
/// bottom taskbar, below on a top one, beside it on left/right taskbars. The
/// result is always clamped into the work area.
pub fn anchor_tray_panel(
    tray_icon: Rect,
    work_area: Rect,
    panel_width: i32,
    panel_height: i32,
) -> Rect {
    let edge = detect_taskbar_edge(tray_icon, work_area);
    let mut panel = Rect {
        x: 0,
        y: 0,
        width: panel_width,
        height: panel_height,
    };
    let icon_center_x = tray_icon.x + tray_icon.width / 2;
    let icon_center_y = tray_icon.y + tray_icon.height / 2;
    match edge {
        TaskbarEdge::Bottom => {
            panel.y = tray_icon.y - PANEL_GAP - panel_height;
            panel.x = icon_center_x - panel_width / 2;
        }
        TaskbarEdge::Top => {
            panel.y = tray_icon.bottom() + PANEL_GAP;
            panel.x = icon_center_x - panel_width / 2;
        }
        TaskbarEdge::Right => {
            panel.x = tray_icon.x - PANEL_GAP - panel_width;
            panel.y = icon_center_y - panel_height / 2;
        }
        TaskbarEdge::Left => {
            panel.x = tray_icon.right() + PANEL_GAP;
            panel.y = icon_center_y - panel_height / 2;
        }
    }
    clamp_position(&mut panel, work_area);
    panel
}

/// The bounds saver never persists a maximized frame: restoring from the
/// maximize is the user's chosen geometry.
pub(crate) fn should_persist_bounds(maximized: bool, minimized: bool) -> bool {
    !maximized && !minimized
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work(x: i32, y: i32, width: i32, height: i32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn maximized_frames_are_never_persisted() {
        assert!(!should_persist_bounds(true, false));
        assert!(!should_persist_bounds(false, true));
        assert!(!should_persist_bounds(true, true));
        assert!(should_persist_bounds(false, false));
    }

    #[test]
    fn maximized_window_bounds_restore_clamped_into_the_work_area() {
        // Windows reports a maximized frameless window at (-8, -8) with the
        // invisible resize border padding on every side.
        let area = work(0, 0, 1920, 1040);
        let restored = fit_main_window(
            Some(Rect {
                x: -8,
                y: -8,
                width: 1936,
                height: 1056,
            }),
            area,
        );
        assert!(restored.x >= area.x && restored.right() <= area.right());
        assert!(restored.y >= area.y && restored.bottom() <= area.bottom());
        // The size is clamped to the work area, never below the minimum.
        assert_eq!((restored.width, restored.height), (1920, 1040));
    }

    #[test]
    fn maximized_window_bounds_survive_a_scale_1_25_work_area() {
        // 1920x1040 physical at 1.25 scale = 1536x832 logical.
        let area = work(0, 0, 1536, 832);
        let restored = fit_main_window(
            Some(Rect {
                x: -8,
                y: -8,
                width: 1552,
                height: 848,
            }),
            area,
        );
        assert!(restored.x >= area.x && restored.right() <= area.right());
        assert!(restored.y >= area.y && restored.bottom() <= area.bottom());
        assert_eq!((restored.width, restored.height), (1536, 832));
    }

    #[test]
    fn maximized_bounds_on_a_negative_origin_work_area_do_not_panic() {
        // Multi-monitor setups report negative work-area origins.
        let area = work(-1920, 0, 1920, 1040);
        let restored = fit_main_window(
            Some(Rect {
                x: -1928,
                y: -8,
                width: 1936,
                height: 1056,
            }),
            area,
        );
        assert!(restored.x >= area.x && restored.right() <= area.right());
        assert!(restored.y >= area.y && restored.bottom() <= area.bottom());
    }

    #[test]
    fn saved_bounds_keep_the_user_size_and_clamp_into_the_work_area() {
        let area = work(0, 0, 1920, 1040);
        // A window dragged half off-screen comes back intact but visible.
        let restored = fit_main_window(
            Some(Rect {
                x: 5000,
                y: -3000,
                width: 1100,
                height: 800,
            }),
            area,
        );
        assert_eq!((restored.width, restored.height), (1100, 800));
        assert!(restored.x >= area.x && restored.right() <= area.right());
        assert!(restored.y >= area.y && restored.bottom() <= area.bottom());
        assert_eq!(restored.x, area.width - 1100);
        assert_eq!(restored.y, area.y);
    }

    #[test]
    fn saved_bounds_never_drop_below_the_main_minimum() {
        let area = work(0, 0, 1920, 1040);
        let restored = fit_main_window(
            Some(Rect {
                x: 100,
                y: 100,
                width: 400,
                height: 300,
            }),
            area,
        );
        assert_eq!(
            (restored.width, restored.height),
            (MAIN_MIN_WIDTH, MAIN_MIN_HEIGHT)
        );
    }

    #[test]
    fn saved_bounds_shrink_into_a_small_work_area() {
        let area = work(40, 60, 800, 600);
        let restored = fit_main_window(
            Some(Rect {
                x: 0,
                y: 0,
                width: 1600,
                height: 1200,
            }),
            area,
        );
        assert_eq!((restored.width, restored.height), (800, 600));
        assert_eq!((restored.x, restored.y), (area.x, area.y));
    }

    #[test]
    fn first_use_centers_a_work_area_fit() {
        let area = work(0, 0, 2000, 1200);
        let bounds = fit_main_window(None, area);
        let (width, height) = main_size_for(area);
        assert_eq!((bounds.width, bounds.height), (width, height));
        assert_eq!(
            (bounds.x, bounds.y),
            (
                area.x + (area.width - width) / 2,
                area.y + (area.height - height) / 2
            )
        );
    }

    #[test]
    fn first_use_fits_a_tiny_work_area_without_panicking() {
        // A small monitor whose origin is not the screen origin: positions must
        // clamp against the work area even when the window cannot fit.
        let area = work(500, 300, 500, 400);
        let bounds = fit_main_window(None, area);
        assert!(bounds.x >= area.x && bounds.right() <= area.right());
        assert!(bounds.y >= area.y && bounds.bottom() <= area.bottom());

        let restored = fit_main_window(
            Some(Rect {
                x: 0,
                y: 0,
                width: 1600,
                height: 900,
            }),
            area,
        );
        assert!(restored.x >= area.x && restored.right() <= area.right());
        assert!(restored.y >= area.y && restored.bottom() <= area.bottom());
    }

    #[test]
    fn panel_anchors_above_a_bottom_taskbar_and_clamps_horizontally() {
        let area = work(0, 0, 1920, 1040);
        // Tray icon on a bottom taskbar, near the right edge.
        let tray = Rect {
            x: 1800,
            y: 1040,
            width: 40,
            height: 40,
        };
        let panel = anchor_tray_panel(tray, area, TRAY_PANEL_WIDTH, TRAY_PANEL_HEIGHT);
        // Above the icon with the gap.
        assert_eq!(panel.y, tray.y - PANEL_GAP - TRAY_PANEL_HEIGHT);
        assert!(panel.right() <= area.right());
        assert!(panel.x >= area.x);
        // Clamped against the right work-area edge.
        assert_eq!(panel.x, area.right() - TRAY_PANEL_WIDTH);
        assert!(panel.bottom() <= area.bottom());
    }

    #[test]
    fn panel_anchors_below_a_top_taskbar() {
        let area = work(0, 40, 1920, 1000);
        let tray = Rect {
            x: 1800,
            y: 0,
            width: 40,
            height: 40,
        };
        let panel = anchor_tray_panel(tray, area, TRAY_PANEL_WIDTH, TRAY_PANEL_HEIGHT);
        assert_eq!(panel.y, tray.bottom() + PANEL_GAP);
        assert!(panel.bottom() <= area.bottom());
        assert_eq!(panel.x, area.right() - TRAY_PANEL_WIDTH);
    }

    #[test]
    fn panel_anchors_beside_left_and_right_taskbars() {
        let right_area = work(0, 0, 1880, 1040);
        let tray_on_right = Rect {
            x: 1880,
            y: 500,
            width: 40,
            height: 40,
        };
        let panel = anchor_tray_panel(
            tray_on_right,
            right_area,
            TRAY_PANEL_WIDTH,
            TRAY_PANEL_HEIGHT,
        );
        assert_eq!(panel.x, tray_on_right.x - PANEL_GAP - TRAY_PANEL_WIDTH);
        // Vertically centered on the icon, clamped into the work area.
        assert!(panel.y >= right_area.y && panel.bottom() <= right_area.bottom());

        let left_area = work(40, 0, 1880, 1040);
        let tray_on_left = Rect {
            x: 40,
            y: 500,
            width: 40,
            height: 40,
        };
        let panel = anchor_tray_panel(tray_on_left, left_area, TRAY_PANEL_WIDTH, TRAY_PANEL_HEIGHT);
        assert_eq!(panel.x, tray_on_left.right() + PANEL_GAP);
        assert!(panel.right() <= left_area.right());
    }

    #[test]
    fn panel_clamps_on_a_secondary_monitor_offset() {
        // Second monitor to the right of the primary.
        let area = work(1920, 0, 1920, 1040);
        let tray = Rect {
            x: 3700,
            y: 1040,
            width: 40,
            height: 40,
        };
        let panel = anchor_tray_panel(tray, area, TRAY_PANEL_WIDTH, TRAY_PANEL_HEIGHT);
        assert_eq!(panel.y, tray.y - PANEL_GAP - TRAY_PANEL_HEIGHT);
        assert!(panel.x >= area.x && panel.right() <= area.right());
        assert_eq!(panel.x, area.right() - TRAY_PANEL_WIDTH);
    }

    #[test]
    fn panel_stays_inside_a_work_area_smaller_than_itself() {
        let area = work(100, 100, 380, 500);
        let tray = Rect {
            x: 200,
            y: 600,
            width: 40,
            height: 40,
        };
        let panel = anchor_tray_panel(tray, area, TRAY_PANEL_WIDTH, TRAY_PANEL_HEIGHT);
        // The panel keeps its size and its top-left stays inside the work area.
        assert_eq!(
            (panel.width, panel.height),
            (TRAY_PANEL_WIDTH, TRAY_PANEL_HEIGHT)
        );
        assert!(panel.x >= area.x && panel.x <= area.right());
        assert!(panel.y >= area.y && panel.y <= area.bottom());
    }
}
