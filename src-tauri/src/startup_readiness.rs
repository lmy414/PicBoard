//! Per-window startup readiness.
//!
//! Each window label has its own state: the main window is revealed once its
//! page has loaded (native fallback) AND its initial placement is done; the
//! tray flyout never participates in the startup reveal (it is a hidden flyout
//! toggled from the tray icon). Because the state is keyed by label, a signal
//! from one window can never consume another window's reveal.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(crate) struct StartupReadiness {
    windows: Arc<Mutex<HashMap<String, WindowReadiness>>>,
    /// Labels the startup reveal may show. Every other window (the tray
    /// flyout) is a hidden surface toggled from the tray icon.
    revealable: Arc<std::collections::HashSet<String>>,
}

impl Default for StartupReadiness {
    fn default() -> Self {
        Self::new(&["main"])
    }
}

impl StartupReadiness {
    pub(crate) fn new(revealable: &[&str]) -> Self {
        Self {
            windows: Arc::new(Mutex::new(HashMap::new())),
            revealable: Arc::new(
                revealable
                    .iter()
                    .map(|label| label.to_string())
                    .collect(),
            ),
        }
    }
}

#[derive(Default)]
struct WindowReadiness {
    /// Whether the startup reveal may ever show this window.
    revealable: bool,
    /// The window's page finished loading (native fallback signal).
    page_loaded: bool,
    /// Initial placement/bounds were applied.
    placement_done: bool,
    /// The one-shot reveal ran successfully.
    revealed: bool,
    /// The user closed the window into the tray before it was revealed.
    user_hidden: bool,
    /// The user (tray/menu) explicitly showed the window, consuming the
    /// automatic reveal.
    user_shown: bool,
}

impl StartupReadiness {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, WindowReadiness>> {
        self.windows
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn state_for<'a>(
        &self,
        windows: &'a mut HashMap<String, WindowReadiness>,
        label: &str,
    ) -> &'a mut WindowReadiness {
        windows.entry(label.to_owned()).or_insert_with(|| WindowReadiness {
            revealable: self.revealable.contains(label),
            ..WindowReadiness::default()
        })
    }

    fn ready(state: &WindowReadiness) -> bool {
        state.revealable
            && state.page_loaded
            && state.placement_done
            && !state.revealed
            && !state.user_hidden
            && !state.user_shown
    }

    /// The window's page finished loading (native page-load fallback).
    pub(crate) fn mark_page_loaded(&self, label: &str) {
        let mut windows = self.lock();
        self.state_for(&mut windows, label).page_loaded = true;
    }

    /// The window's initial placement (bounds/flags) was applied.
    pub(crate) fn mark_placement_done(&self, label: &str) {
        let mut windows = self.lock();
        self.state_for(&mut windows, label).placement_done = true;
    }

    /// Both signals for this window are set and the one-shot reveal has not run
    /// yet (and the user has not hidden/shown the window themselves).
    pub(crate) fn should_reveal(&self, label: &str) -> bool {
        let windows = self.lock();
        windows
            .get(label)
            .map(Self::ready)
            .unwrap_or(false)
    }

    /// Consume the one-shot reveal after a successful `show()`.
    pub(crate) fn mark_revealed(&self, label: &str) {
        let mut windows = self.lock();
        self.state_for(&mut windows, label).revealed = true;
    }

    /// The user closed the window into the tray before it was revealed: the
    /// automatic reveal must never fire afterwards.
    pub(crate) fn mark_user_hidden(&self, label: &str) {
        let mut windows = self.lock();
        let state = self.state_for(&mut windows, label);
        state.user_hidden = true;
    }

    /// The user (tray/menu) explicitly showed the window, consuming the
    /// automatic reveal.
    pub(crate) fn mark_user_shown(&self, label: &str) {
        let mut windows = self.lock();
        let state = self.state_for(&mut windows, label);
        state.user_shown = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: &str = "main";
    const TRAY: &str = "tray";

    /// The host-side reveal: gate on both signals, run the show, consume the
    /// one-shot on success.
    fn reveal_via<R: FnMut() -> bool>(
        readiness: &StartupReadiness,
        label: &str,
        reveal: &mut R,
    ) -> bool {
        readiness.mark_page_loaded(label);
        readiness.mark_placement_done(label);
        if !readiness.should_reveal(label) {
            return false;
        }
        if reveal() {
            readiness.mark_revealed(label);
            true
        } else {
            false
        }
    }

    #[test]
    fn tray_signals_never_reveal_main_and_vice_versa() {
        let readiness = StartupReadiness::new(&[MAIN]);
        let reveals = std::cell::Cell::new(0);
        let mut reveal = || {
            reveals.set(reveals.get() + 1);
            true
        };

        // The tray page loads and its placement is done first: the tray is a
        // hidden flyout, so nothing is revealed and MAIN is untouched.
        assert!(!reveal_via(&readiness, TRAY, &mut reveal));
        assert!(!readiness.should_reveal(MAIN));
        assert_eq!(reveals.get(), 0);

        // Now main becomes ready: it reveals exactly once.
        assert!(reveal_via(&readiness, MAIN, &mut reveal));
        assert!(!reveal_via(&readiness, MAIN, &mut reveal));
        assert_eq!(reveals.get(), 1);

        // Later tray signals still never reveal main.
        assert!(!reveal_via(&readiness, TRAY, &mut reveal));
        assert_eq!(reveals.get(), 1);
    }

    #[test]
    fn main_signals_before_tray_reveal_exactly_once() {
        let readiness = StartupReadiness::new(&[MAIN]);
        let reveals = std::cell::Cell::new(0);
        let mut reveal = || {
            reveals.set(reveals.get() + 1);
            true
        };

        assert!(reveal_via(&readiness, MAIN, &mut reveal));
        assert!(!reveal_via(&readiness, MAIN, &mut reveal));
        assert!(!reveal_via(&readiness, TRAY, &mut reveal));
        assert_eq!(reveals.get(), 1);
    }

    #[test]
    fn page_load_fallback_reveals_without_host_ready() {
        // The renderer's host:ready cannot fire while the window is hidden
        // (WebView2 suspends rendering, so rAF never runs): the native
        // page-load is the operative signal.
        let readiness = StartupReadiness::new(&[MAIN]);
        let reveals = std::cell::Cell::new(0);
        let mut reveal = || {
            reveals.set(reveals.get() + 1);
            true
        };

        assert!(reveal_via(&readiness, MAIN, &mut reveal));
        assert_eq!(reveals.get(), 1);
    }

    #[test]
    fn failed_reveal_retries_on_the_next_signal() {
        let readiness = StartupReadiness::new(&[MAIN]);
        let attempts = std::cell::Cell::new(0);
        let mut failing = || {
            attempts.set(attempts.get() + 1);
            false
        };

        readiness.mark_page_loaded(MAIN);
        // A failed show does not consume the one-shot: every subsequent signal
        // retries the reveal.
        assert!(!reveal_via(&readiness, MAIN, &mut failing));
        assert_eq!(attempts.get(), 1);
        assert!(!reveal_via(&readiness, MAIN, &mut failing));
        assert_eq!(attempts.get(), 2);

        assert!(reveal_via(&readiness, MAIN, &mut || {
            attempts.set(attempts.get() + 1);
            true
        }));
        // Once revealed, no further attempts are made.
        assert!(!reveal_via(&readiness, MAIN, &mut failing));
        assert_eq!(attempts.get(), 3);
    }

    #[test]
    fn user_hide_before_readiness_never_auto_reveals() {
        let readiness = StartupReadiness::new(&[MAIN]);
        readiness.mark_user_hidden(MAIN);

        assert!(!reveal_via(&readiness, MAIN, &mut || true));

        // An explicit user show consumes the automatic reveal for good.
        readiness.mark_user_shown(MAIN);
        assert!(!reveal_via(&readiness, MAIN, &mut || true));
    }
}
