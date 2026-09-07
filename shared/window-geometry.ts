export interface WindowBounds { x: number; y: number; width: number; height: number }

export interface WorkArea { x: number; y: number; width: number; height: number }

export interface WindowGeometryState {
  expanded: boolean;
  collapsedBounds: WindowBounds | null;
  collapsedWorkArea: WorkArea | null;
}

export interface WindowExpansionTransition {
  bounds: WindowBounds;
  state: WindowGeometryState;
  changed: boolean;
}

export function createWindowGeometryState(): WindowGeometryState {
  return { expanded: false, collapsedBounds: null, collapsedWorkArea: null };
}

export function fitWindowToWorkArea(current: WindowBounds, workArea: WorkArea, expanded: boolean): WindowBounds {
  const width = expanded ? Math.min(660, Math.max(320, workArea.width - 24)) : 88;
  const height = expanded ? Math.min(760, Math.max(320, workArea.height - 24)) : 88;
  return {
    x: Math.min(Math.max(current.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(current.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height,
  };
}

function sameBounds(left: WindowBounds, right: WindowBounds) {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

export function transitionWindowExpansion(
  current: WindowBounds,
  workArea: WorkArea,
  expanded: boolean,
  state: WindowGeometryState,
): WindowExpansionTransition {
  if (state.expanded === expanded) return { bounds: current, state, changed: false };

  if (expanded) {
    const bounds = fitWindowToWorkArea(current, workArea, true);
    const nextState: WindowGeometryState = {
      expanded: true,
      collapsedBounds: { ...current },
      collapsedWorkArea: { ...workArea },
    };
    return { bounds, state: nextState, changed: !sameBounds(current, bounds) };
  }

  const restoreBounds = state.collapsedBounds ?? current;
  const bounds = fitWindowToWorkArea(restoreBounds, workArea, false);
  return {
    bounds,
    state: createWindowGeometryState(),
    changed: !sameBounds(current, bounds),
  };
}
