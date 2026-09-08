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
            Some(Rect {
                x: x0,
                y: y0,
                width: x1 - x0,
                height: y1 - y0,
            })
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
    WindowGeometryState {
        expanded: false,
        collapsed_bounds: None,
        collapsed_work_area: None,
    }
}

/// Fit a candidate window rect into a work area.
/// Expanded windows are clamped to 320..=660 wide and 320..=760 high (and never
/// larger than the work area minus a 24px margin). Collapsed windows are always
/// 88x88. Mirrors `fitWindowToWorkArea` from the shared contract.
pub fn fit_window_to_work_area(current: Rect, work_area: Rect, expanded: bool) -> Rect {
    let available_width = work_area.width.max(1);
    let available_height = work_area.height.max(1);
    let (width, height) = if expanded {
        let width = work_area
            .width
            .saturating_sub(24)
            .clamp(320, 660)
            .min(available_width);
        let height = work_area
            .height
            .saturating_sub(24)
            .clamp(320, 760)
            .min(available_height);
        (width, height)
    } else {
        (88.min(available_width), 88.min(available_height))
    };
    let max_x = work_area
        .x
        .saturating_add(available_width.saturating_sub(width));
    let max_y = work_area
        .y
        .saturating_add(available_height.saturating_sub(height));
    let x = current.x.clamp(work_area.x, max_x);
    let y = current.y.clamp(work_area.y, max_y);
    Rect {
        x,
        y,
        width,
        height,
    }
}

fn same_bounds(left: Rect, right: Rect) -> bool {
    left.x == right.x
        && left.y == right.y
        && left.width == right.width
        && left.height == right.height
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
        let bounds = fit_window_to_work_area(current, work_area, expanded);
        return (bounds, !same_bounds(current, bounds));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_expansion_repairs_collapsed_actual_bounds_after_reload() {
        let work = Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };
        let mut state = WindowGeometryState {
            expanded: true,
            collapsed_bounds: Some(Rect {
                x: 1600,
                y: 20,
                width: 88,
                height: 88,
            }),
            collapsed_work_area: Some(work),
        };
        let current = Rect {
            x: 1600,
            y: 20,
            width: 88,
            height: 88,
        };

        let (bounds, changed) = transition_window_expansion(current, work, true, &mut state);

        assert!(changed);
        assert_eq!((bounds.width, bounds.height), (660, 760));
        assert!(state.expanded);
    }

    #[test]
    fn tiny_work_area_never_panics_or_places_window_outside_origin() {
        let work = Rect {
            x: -20,
            y: 10,
            width: 120,
            height: 80,
        };
        let current = Rect {
            x: 500,
            y: 500,
            width: 88,
            height: 88,
        };

        let collapsed = fit_window_to_work_area(current, work, false);
        let expanded = fit_window_to_work_area(current, work, true);

        assert!(collapsed.x >= work.x && collapsed.x + collapsed.width <= work.x + work.width);
        assert!(collapsed.y >= work.y && collapsed.y + collapsed.height <= work.y + work.height);
        assert_eq!((expanded.x, expanded.y), (work.x, work.y));
        assert!(collapsed.width <= work.width && collapsed.height <= work.height);
        assert!(expanded.width <= work.width && expanded.height <= work.height);
    }
}
