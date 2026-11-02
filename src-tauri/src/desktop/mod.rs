//! Desktop-lifecycle host support: window close behavior, tray entry, launch
//! at startup and system directory picking.
//!
//! Ownership/scope notes:
//! - The close-behavior preference lives in a small sidecar JSON file
//!   (`desktop-settings.json`) next to the business `state.json` under the same
//!   (isolated) data root, so dev runs never pollute the real user
//!   preferences and no image-library transaction is touched.
//! - Auto-start is read/written on the real system registry ONLY in release
//!   builds and only through explicit user action (the renderer toggle is
//!   hidden/unavailable in dev). Debug builds report `autoStartAvailable =
//!   false` and never register an entry.

mod autostart;
mod host;
pub mod image_association;
mod picker;
mod prefs;
mod tray;

pub use autostart::AutoStartManager;
pub use host::{
    install_close_behavior, remember_window_bounds, setup as setup_desktop, update_settings,
    DesktopState,
};
pub use picker::pick_directory;
pub use prefs::{CloseBehavior, GridSize, HistoryRetentionDays, SavedWindowBounds};
pub use tray::setup_tray;
