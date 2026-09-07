export interface LookTarget {
  yaw: number;
  pitch: number;
}

export const MAX_LOOK_YAW = 28;
export const MAX_LOOK_PITCH = 24;

/** Convert normalized pointer coordinates into a bounded, forward-facing look target. */
export function pointerToLookTarget(x: number, y: number, maxYaw = MAX_LOOK_YAW, maxPitch = MAX_LOOK_PITCH): LookTarget {
  let normalizedX = Number.isFinite(x) ? x : 0;
  let normalizedY = Number.isFinite(y) ? y : 0;
  const radius = Math.hypot(normalizedX, normalizedY);
  if (radius > 1) {
    normalizedX /= radius;
    normalizedY /= radius;
  }
  const yawLimit = Number.isFinite(maxYaw) && maxYaw >= 0 ? maxYaw : MAX_LOOK_YAW;
  const pitchLimit = Number.isFinite(maxPitch) && maxPitch >= 0 ? maxPitch : MAX_LOOK_PITCH;
  return {
    yaw: normalizedX * yawLimit,
    pitch: -normalizedY * pitchLimit,
  };
}
