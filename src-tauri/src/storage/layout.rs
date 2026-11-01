//! Overlap-free placement for canvas items.
//!
//! An item is either a node or the frame of a direct child canvas (a
//! sub-canvas card); the two kinds block each other. Two items count as
//! overlapping when they are closer than [`GAP`] on both axes.
//!
//! Placement is deterministic: snap the set's first item to the grid when
//! snapping is on, then (if the set collides) walk lattice offsets in square
//! rings of increasing distance and take the first free one. Ties are resolved
//! by Euclidean distance, then smaller `|dy|`, then right before left, then
//! down before up. When nothing fits inside the search budget the set is placed
//! just right of every obstacle.

use std::cmp::Ordering;

/// Minimum clearance between two items on both axes.
pub(crate) const GAP: f64 = 16.0;
/// Offsets are searched on this lattice when snapping is off.
const FREE_STEP: f64 = 8.0;
/// Upper bound on tested offsets before falling back to "right of everything".
const MAX_CANDIDATES: usize = 20_000;
/// Cells larger than this many buckets are tested on every query instead.
const MAX_CELLS_PER_OBSTACLE: usize = 64;
const CELL_SIZE: f64 = 384.0;
/// Hard bound on cascade steps, so a pathological layout cannot spin.
const MAX_PUSH_STEPS: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub(crate) fn right(self) -> f64 {
        self.x + self.width
    }

    pub(crate) fn bottom(self) -> f64 {
        self.y + self.height
    }

    /// Items collide when their gap is smaller than [`GAP`] on both axes:
    /// inflating each rect by `GAP / 2` and testing for intersection.
    pub(crate) fn collides(self, other: Rect) -> bool {
        self.x < other.right() + GAP
            && other.x < self.right() + GAP
            && self.y < other.bottom() + GAP
            && other.y < self.bottom() + GAP
    }

    fn shifted(self, offset: Offset) -> Rect {
        Rect {
            x: self.x + offset.dx,
            y: self.y + offset.dy,
            ..self
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Offset {
    pub dx: f64,
    pub dy: f64,
}

impl Offset {
    pub(crate) const ZERO: Offset = Offset { dx: 0.0, dy: 0.0 };
}

/// Snapping configuration taken from the desktop settings.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct GridOptions {
    pub enabled: bool,
    pub size: f64,
}

impl Default for GridOptions {
    fn default() -> Self {
        Self {
            enabled: true,
            size: 24.0,
        }
    }
}

impl GridOptions {
    fn step(self) -> f64 {
        if self.enabled {
            self.size.max(1.0)
        } else {
            FREE_STEP
        }
    }
}

/// Desktop layout settings mirrored from `desktop-settings.json`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct LayoutSettings {
    pub snap_to_grid: bool,
    pub grid_size: u32,
}

impl Default for LayoutSettings {
    fn default() -> Self {
        Self {
            // Free mode by default: the first drag follows the pointer exactly.
            snap_to_grid: false,
            grid_size: 24,
        }
    }
}

impl LayoutSettings {
    pub(crate) fn options(self) -> GridOptions {
        GridOptions {
            enabled: self.snap_to_grid,
            size: self.grid_size.max(1) as f64,
        }
    }
}

pub(crate) fn snap(value: f64, grid: GridOptions) -> f64 {
    if !grid.enabled || !value.is_finite() {
        return value;
    }
    (value / grid.size).round() * grid.size
}

fn snap_up(value: f64, grid: GridOptions) -> f64 {
    if !grid.enabled || !value.is_finite() {
        return value;
    }
    (value / grid.size).ceil() * grid.size
}

/// Resolve the placement of `set` (proposed rects) against `obstacles`.
///
/// The same offset is applied to every rect of the set, so a multi-item move
/// keeps its relative layout.
pub(crate) fn resolve(set: &[Rect], obstacles: &[Rect], grid: GridOptions) -> Offset {
    resolve_with_budget(set, obstacles, grid, MAX_CANDIDATES)
}

fn resolve_with_budget(
    set: &[Rect],
    obstacles: &[Rect],
    grid: GridOptions,
    max_candidates: usize,
) -> Offset {
    let Some(first) = set.first() else {
        return Offset::ZERO;
    };
    // Snap the set's first item and carry the same delta to the rest.
    let base = Offset {
        dx: snap(first.x, grid) - first.x,
        dy: snap(first.y, grid) - first.y,
    };
    if obstacles.is_empty() {
        return base;
    }
    let index = SpatialIndex::new(obstacles);
    if !collides(set, base, &index) {
        return base;
    }

    let step = grid.step();
    let mut tested = 0usize;
    let mut ring = 1i64;
    while tested < max_candidates {
        let mut candidates = ring_offsets(ring);
        candidates.sort_by(|left, right| compare_offsets(*left, *right));
        for (i, j) in candidates {
            tested += 1;
            if tested > max_candidates {
                break;
            }
            let offset = Offset {
                dx: base.dx + i as f64 * step,
                dy: base.dy + j as f64 * step,
            };
            if !collides(set, offset, &index) {
                return offset;
            }
        }
        ring += 1;
    }

    // Nothing fits: park the set just right of every obstacle.
    let Some(bbox) = bounding_rect(obstacles) else {
        return base;
    };
    let min_x = set
        .iter()
        .map(|rect| rect.x)
        .fold(f64::INFINITY, f64::min);
    let target = snap_up(bbox.right() + GAP, grid);
    Offset {
        dx: target - min_x,
        dy: base.dy,
    }
}

fn collides(set: &[Rect], offset: Offset, index: &SpatialIndex) -> bool {
    set.iter()
        .any(|rect| index.collides(&rect.shifted(offset)))
}

fn bounding_rect(rects: &[Rect]) -> Option<Rect> {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for rect in rects {
        min_x = min_x.min(rect.x);
        min_y = min_y.min(rect.y);
        max_x = max_x.max(rect.right());
        max_y = max_y.max(rect.bottom());
    }
    if !min_x.is_finite() {
        return None;
    }
    Some(Rect {
        x: min_x,
        y: min_y,
        width: max_x - min_x,
        height: max_y - min_y,
    })
}

/// Integer lattice points whose Chebyshev distance from the origin is `ring`.
fn ring_offsets(ring: i64) -> Vec<(i64, i64)> {
    let mut points = Vec::with_capacity((8 * ring) as usize);
    for i in -ring..=ring {
        for j in -ring..=ring {
            if i.abs() == ring || j.abs() == ring {
                points.push((i, j));
            }
        }
    }
    points
}

/// Deterministic candidate order: nearest first, then smaller `|dy|`, then
/// right before left, then down before up.
fn compare_offsets(left: (i64, i64), right: (i64, i64)) -> Ordering {
    let key = |(i, j): (i64, i64)| {
        let distance = i * i + j * j;
        let axis = |value: i64| match value {
            value if value > 0 => 0,
            0 => 1,
            _ => 2,
        };
        (distance, j.abs(), axis(i), axis(j))
    };
    key(left).cmp(&key(right))
}

/// Uniform grid over obstacles, so a candidate only tests nearby items.
struct SpatialIndex {
    cells: std::collections::HashMap<(i64, i64), Vec<usize>>,
    oversized: Vec<usize>,
    obstacles: Vec<Rect>,
}

impl SpatialIndex {
    fn new(obstacles: &[Rect]) -> Self {
        let mut cells: std::collections::HashMap<(i64, i64), Vec<usize>> =
            std::collections::HashMap::new();
        let mut oversized = Vec::new();
        for (index, rect) in obstacles.iter().enumerate() {
            let inflated = inflate(*rect);
            let (min_x, min_y) = cell_of(inflated.x, inflated.y);
            let (max_x, max_y) = cell_of(inflated.right(), inflated.bottom());
            let count = ((max_x - min_x + 1) * (max_y - min_y + 1)) as usize;
            if count > MAX_CELLS_PER_OBSTACLE {
                oversized.push(index);
                continue;
            }
            for x in min_x..=max_x {
                for y in min_y..=max_y {
                    cells.entry((x, y)).or_default().push(index);
                }
            }
        }
        Self {
            cells,
            oversized,
            obstacles: obstacles.to_vec(),
        }
    }

    fn collides(&self, rect: &Rect) -> bool {
        let inflated = inflate(*rect);
        if self
            .oversized
            .iter()
            .any(|index| rect.collides(self.obstacles[*index]))
        {
            return true;
        }
        let (min_x, min_y) = cell_of(inflated.x, inflated.y);
        let (max_x, max_y) = cell_of(inflated.right(), inflated.bottom());
        for x in min_x..=max_x {
            for y in min_y..=max_y {
                let Some(bucket) = self.cells.get(&(x, y)) else {
                    continue;
                };
                // A bucket can be visited more than once for large query rects;
                // repeating a collision test is cheaper than allocating a set.
                for index in bucket {
                    if rect.collides(self.obstacles[*index]) {
                        return true;
                    }
                }
            }
        }
        false
    }
}

fn inflate(rect: Rect) -> Rect {
    Rect {
        x: rect.x - GAP / 2.0,
        y: rect.y - GAP / 2.0,
        width: rect.width + GAP,
        height: rect.height + GAP,
    }
}

fn cell_of(x: f64, y: f64) -> (i64, i64) {
    let cell = |value: f64| {
        if value.is_finite() {
            (value / CELL_SIZE).floor() as i64
        } else {
            0
        }
    };
    (cell(x), cell(y))
}

/// Push items down after `grown` increased in height.
///
/// `items` are the other movable items on the same canvas. Every item the grown
/// rect overlaps moves so its top is `grown.bottom + GAP` (rounded up to the
/// grid when snapping), and pushes cascade to whatever it now overlaps. The
/// grown item itself is not part of `items` and never moves.
pub(crate) fn push_down(grown: Rect, items: &mut [Rect], grid: GridOptions) {
    // `None` is the grown item; `Some(index)` is a movable item that was
    // already pushed and now acts as a pusher.
    let mut queue: Vec<(Option<usize>, Rect)> = vec![(None, grown)];
    let mut steps = 0usize;
    while !queue.is_empty() && steps < MAX_PUSH_STEPS {
        // Ascending y keeps the cascade deterministic.
        queue.sort_by(|left, right| {
            left.1
                .y
                .partial_cmp(&right.1.y)
                .unwrap_or(Ordering::Equal)
                .then_with(|| left.1.x.partial_cmp(&right.1.x).unwrap_or(Ordering::Equal))
        });
        let (pusher_index, pusher) = queue.remove(0);
        steps += 1;
        let target = snap_up(pusher.bottom() + GAP, grid);
        for (index, item) in items.iter_mut().enumerate() {
            if Some(index) == pusher_index {
                continue;
            }
            if item.y >= target {
                continue;
            }
            if !pusher.collides(*item) {
                continue;
            }
            item.y = target;
            queue.push((Some(index), *item));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn overlaps_any(rects: &[Rect]) -> bool {
        rects
            .iter()
            .enumerate()
            .any(|(index, left)| rects[index + 1..].iter().any(|right| left.collides(*right)))
    }

    #[test]
    fn gap_is_sixteen_and_touching_rects_do_not_collide() {
        let left = rect(0.0, 0.0, 100.0, 100.0);
        // Exactly GAP apart on x: separate.
        assert!(!left.collides(rect(116.0, 0.0, 100.0, 100.0)));
        // 15 px apart: overlapping.
        assert!(left.collides(rect(115.0, 0.0, 100.0, 100.0)));
        // Overlapping on x but far apart on y: separate.
        assert!(!left.collides(rect(0.0, 117.0, 100.0, 100.0)));
    }

    #[test]
    fn snap_rounds_the_top_left_and_is_skipped_when_disabled() {
        let on = GridOptions {
            enabled: true,
            size: 24.0,
        };
        let off = GridOptions {
            enabled: false,
            size: 24.0,
        };
        assert_eq!(snap(13.0, on), 24.0);
        assert_eq!(snap(29.0, on), 24.0);
        assert_eq!(snap(36.0, on), 48.0);
        assert_eq!(snap(13.0, off), 13.0);
        assert_eq!(snap_up(20.0, on), 24.0);
        assert_eq!(snap_up(24.0, on), 24.0);
    }

    #[test]
    fn free_proposals_keep_their_position_and_snapping_only_rounds() {
        let grid = GridOptions {
            enabled: true,
            size: 24.0,
        };
        let free = [rect(48.0, 24.0, 100.0, 80.0)];
        assert_eq!(resolve(&free, &[], grid), Offset::ZERO);
        // Sub-grid proposals snap; no obstacle means no extra displacement.
        let offset = resolve(&[rect(50.0, 30.0, 100.0, 80.0)], &[], grid);
        assert_eq!(offset, Offset { dx: -2.0, dy: -6.0 });
        let off = GridOptions {
            enabled: false,
            size: 24.0,
        };
        assert_eq!(resolve(&[rect(50.0, 30.0, 100.0, 80.0)], &[], off), Offset::ZERO);
    }

    #[test]
    fn colliding_set_moves_to_the_minimal_lattice_offset() {
        let grid = GridOptions {
            enabled: true,
            size: 24.0,
        };
        let obstacle = [rect(0.0, 0.0, 100.0, 100.0)];
        // Same rect on top of the obstacle: needs 108 px of x or y separation,
        // so the first free lattice point is (120, 0).
        let offset = resolve(&[rect(0.0, 0.0, 100.0, 100.0)], &obstacle, grid);
        assert_eq!(offset, Offset { dx: 120.0, dy: 0.0 });
        let moved = rect(offset.dx, offset.dy, 100.0, 100.0);
        assert!(!moved.collides(obstacle[0]));
    }

    #[test]
    fn multi_item_move_keeps_relative_layout() {
        let grid = GridOptions {
            enabled: true,
            size: 24.0,
        };
        let obstacles = [rect(0.0, 0.0, 100.0, 100.0)];
        // Two nodes 120 px apart, dropped onto the obstacle.
        let set = [rect(0.0, 0.0, 100.0, 100.0), rect(120.0, 0.0, 100.0, 100.0)];
        let offset = resolve(&set, &obstacles, grid);
        let moved: Vec<Rect> = set.iter().map(|rect| rect.shifted(offset)).collect();
        assert_eq!(moved[1].x - moved[0].x, 120.0);
        assert_eq!(moved[1].y - moved[0].y, 0.0);
        for item in &moved {
            assert!(!item.collides(obstacles[0]));
        }
        assert!(!overlaps_any(&moved));
    }

    #[test]
    fn cards_and_nodes_block_each_other() {
        let grid = GridOptions {
            enabled: false,
            size: 24.0,
        };
        // A child-canvas card occupies the proposal; the node must move.
        let card = [rect(100.0, 100.0, 280.0, 180.0)];
        let offset = resolve(&[rect(100.0, 100.0, 120.0, 80.0)], &card, grid);
        assert_ne!(offset, Offset::ZERO);
        let moved = rect(100.0 + offset.dx, 100.0 + offset.dy, 120.0, 80.0);
        assert!(!moved.collides(card[0]));
        // Free space right next to a card is accepted.
        assert_eq!(
            resolve(&[rect(400.0, 100.0, 120.0, 80.0)], &card, grid),
            Offset::ZERO
        );
    }

    #[test]
    fn search_falls_back_to_the_right_of_every_obstacle() {
        let grid = GridOptions {
            enabled: true,
            size: 24.0,
        };
        let obstacles = [rect(0.0, 0.0, 100.0, 100.0)];
        // Budget of one candidate: the ring search cannot even try ring 1's
        // first point, so the fallback places the set right of the bbox.
        let offset = resolve_with_budget(
            &[rect(0.0, 0.0, 100.0, 100.0)],
            &obstacles,
            grid,
            1,
        );
        assert_eq!(offset.dx, 120.0); // snap_up(100 + 16, 24)
        assert_eq!(offset.dy, 0.0);
        let moved = rect(offset.dx, offset.dy, 100.0, 100.0);
        assert!(!moved.collides(obstacles[0]));
    }

    #[test]
    fn growth_pushes_down_only_overlapping_items_and_cascades() {
        let grid = GridOptions {
            enabled: true,
            size: 24.0,
        };
        let grown = rect(0.0, 0.0, 280.0, 264.0);
        // Directly below (would overlap after growth), a second row that the
        // first push cascades into, and one item far away.
        let mut items = vec![
            rect(0.0, 200.0, 280.0, 100.0),
            rect(0.0, 320.0, 280.0, 100.0),
            rect(1000.0, 0.0, 100.0, 100.0),
        ];
        push_down(grown, &mut items, grid);
        // First pushed to 264 + 16 = 280 -> snapped up to 288.
        assert_eq!(items[0].y, 288.0);
        // Cascade: 288 + 100 + 16 = 404 -> 408.
        assert_eq!(items[1].y, 408.0);
        // Far item untouched.
        assert_eq!(items[2], rect(1000.0, 0.0, 100.0, 100.0));
        // The grown rect never moves (it is not in `items`).
        assert!(!grown.collides(items[0]));
        assert!(!items[0].collides(items[1]));
    }

    #[test]
    fn growth_without_snapping_uses_the_exact_gap() {
        let grid = GridOptions {
            enabled: false,
            size: 24.0,
        };
        let grown = rect(0.0, 0.0, 280.0, 200.0);
        let mut items = vec![rect(0.0, 150.0, 280.0, 60.0)];
        push_down(grown, &mut items, grid);
        assert_eq!(items[0].y, 216.0);
    }

    #[test]
    fn resolve_stays_fast_and_clean_on_a_500_item_canvas() {
        let grid = GridOptions {
            enabled: true,
            size: 24.0,
        };
        // 25 x 20 grid of 280x100 cards, dense but realistic.
        let mut obstacles = Vec::with_capacity(500);
        for row in 0..20 {
            for column in 0..25 {
                obstacles.push(rect(
                    column as f64 * 296.0,
                    row as f64 * 116.0,
                    280.0,
                    100.0,
                ));
            }
        }
        let started = std::time::Instant::now();
        let set = [rect(100.0, 100.0, 280.0, 100.0)];
        let offset = resolve(&set, &obstacles, grid);
        let elapsed = started.elapsed();
        let moved = set[0].shifted(offset);
        assert!(
            obstacles.iter().all(|item| !moved.collides(*item)),
            "resolved position still overlaps"
        );
        assert!(
            elapsed.as_millis() < 500,
            "500-item resolve took {elapsed:?}"
        );
    }
}
