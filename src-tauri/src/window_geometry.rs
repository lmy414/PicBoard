//! Window bounds/geometry helpers shared between the host and the renderer.
//! Mirrors `shared/window-geometry.ts` semantics: the renderer works in logical
//! (CSS) pixels while Windows host calls operate in physical pixels, so the host
//! converts bounds at the boundary using the window scale factor.

/// Physical-pixel rectangle used for monitor work areas and window bounds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub fn contains_point(&self, x: i32, y: i32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }

    pub fn intersection(&self, other: &Rect) -> Option<Rect> {
        let x0 = self.x.max(other.x);
        let y0 = self.y.max(other.y);
        let x1 = (self.x + self.width).min(other.x + other.width);
        let y1 = (self.y + self.height).min(other.y + other.height);
        if x1 <= x0 || y1 <= y0 {
            None
        } else {
            Some(Rect { x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct WindowGeometryState {
    pub expanded: bool,
    pub collapsed_bounds: Option<Rect>,
    pub collapsed_work_area: Option<Rect>,
}

pub fn create_window_geometry_state() -> WindowGeometryState {
    WindowGeometryState { expanded: false, collapsed_bounds: None, collapsed_work_area: None }
}

/// Fit a candidate window rect into a work area.
/// Expanded windows are clamped to 320..=660 wide and 320..=760 high (and never
/// larger than the work area minus a 24px margin). Collapsed windows are always
/// 88x88. Mirrors `fitWindowToWorkArea` from the shared contract.
pub fn fit_window_to_work_area(current: Rect, work_area: Rect, expanded: bool) -> Rect {
    let (width, height) = if expanded {
        let width = work_area.width.saturating_sub(24).clamp(320, 660);
        let height = work_area.height.saturating_sub(24).clamp(320, 760);
        (width, height)
    } else {
        (88, 88)
    };
    let x = current.x.clamp(work_area.x, work_area.x + work_area.width - width);
    let y = current.y.clamp(work_area.y, work_area.y + work_area.height - height);
    Rect { x, y, width, height }
}

fn same_bounds(left: Rect, right: Rect) -> bool {
    left.x == right.x && left.y == right.y && left.width == right.width && left.height == right.height
}

/// Transition between collapsed and expanded states, mirroring
/// `transitionWindowExpansion` from the shared contract.
pub fn transition_window_expansion(
    current: Rect,
    work_area: Rect,
    expanded: bool,
    state: &mut WindowGeometryState,
) -> (Rect, bool) {
    if state.expanded == expanded {
        return (current, false);
    }
    if expanded {
        let bounds = fit_window_to_work_area(current, work_area, true);
        state.expanded = true;
        state.collapsed_bounds = Some(current);
        state.collapsed_work_area = Some(work_area);
        return (bounds, !same_bounds(current, bounds));
    }
    let restore_bounds = state.collapsed_bounds.unwrap_or(current);
    let bounds = fit_window_to_work_area(restore_bounds, work_area, false);
    *state = create_window_geometry_state();
    (bounds, !same_bounds(current, bounds))
}
