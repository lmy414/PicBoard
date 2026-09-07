//! Preference origin-compatibility migration for the Tauri host.
//!
//! Electron stored `quick-image-board.ball-settings` and
//! `quick-image-board.path-settings` in Chromium localStorage under the Electron
//! origin, which WebView2 does not inherit. The Rust host accepts an explicit
//! validated export (`npm run export:prefs` + `--preferences-export`), keeps it
//! in a controlled sidecar file, and exposes it through `bootstrap_preferences`
//! so the renderer can seed its localStorage *before* React initializes its
//! default-state effects.
//!
//! The renderer's own localStorage read/write semantics are unchanged; this
//! module only runs once, at bootstrap, and never overwrites an existing valid
//! value.

import { invoke } from "@tauri-apps/api/core";
import { BALL_SETTINGS_KEY, normalizeBallSettings } from "../ball-settings";

export const PATH_SETTINGS_KEY = "quick-image-board.path-settings";

interface BootstrapPreferences {
  ballSettings?: unknown;
  pathSettings?: unknown;
}

/** Fetch validated migration preferences from the host (if any were supplied). */
export async function loadBootstrapPreferences(): Promise<BootstrapPreferences> {
  try {
    const raw = await invoke<{ ballSettings?: unknown; pathSettings?: unknown } | null>(
      "bootstrap_preferences",
    );
    if (!raw) return {};
    return {
      ballSettings: raw.ballSettings ? normalizeBallSettings(raw.ballSettings) : undefined,
      pathSettings: raw.pathSettings && typeof raw.pathSettings === "object"
        ? raw.pathSettings
        : undefined,
    };
  } catch (caught) {
    console.error("preference bootstrap failed", caught);
    return {};
  }
}

function normalizePathSettings(value: unknown): unknown {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    filePath: typeof candidate.filePath === "string" ? candidate.filePath : "quick-image-board",
    classifiedPath: typeof candidate.classifiedPath === "string" ? candidate.classifiedPath : "quick-image-board/classified",
    temporaryPath: typeof candidate.temporaryPath === "string" ? candidate.temporaryPath : "quick-image-board/pending",
  };
}

/**
 * Seed renderer localStorage with host-provided values. Existing keys win; a
 * key that is already present is never overwritten.
 */
export function applyBootstrapPreferences(preferences: BootstrapPreferences) {
  try {
    const storage = window.localStorage;
    if (preferences.ballSettings && !storage.getItem(BALL_SETTINGS_KEY)) {
      storage.setItem(BALL_SETTINGS_KEY, JSON.stringify(preferences.ballSettings));
    }
    if (preferences.pathSettings && !storage.getItem(PATH_SETTINGS_KEY)) {
      const normalized = normalizePathSettings(preferences.pathSettings);
      storage.setItem(PATH_SETTINGS_KEY, JSON.stringify(normalized));
    }
  } catch (caught) {
    // localStorage may be unavailable in private contexts; settings fall back
    // to defaults by design.
    console.warn("could not seed migrated preferences", caught);
  }
}
