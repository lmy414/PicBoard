use std::sync::{Arc, Mutex};

/// Coordinates the one-shot initial reveal between native page loading and the
/// renderer's `host:ready` event. Both signals are intentionally accepted:
/// page-load finished is the native fallback, while renderer readiness waits
/// until the app has committed its first frame.
#[derive(Default, Clone)]
pub(crate) struct StartupReadiness {
    state: Arc<Mutex<State>>,
}

#[derive(Default)]
struct State {
    page_ready: bool,
    initial_placement_done: bool,
    user_hidden: bool,
    initial_visibility_decided: bool,
}

impl StartupReadiness {
    /// Handle a native page-load finish or renderer `host:ready` event. The
    /// callback runs while the state lock is held, so a concurrent tray hide
    /// cannot be undone by a delayed readiness callback.
    pub(crate) fn page_ready_and_reveal<F>(&self, reveal: F) -> bool
    where
        F: FnOnce() -> bool,
    {
        let mut state = self.lock_state();
        state.page_ready = true;
        Self::reveal_if_ready(&mut state, reveal)
    }

    /// Handle completion of initial native placement, with the same atomic
    /// reveal guarantee as [`Self::page_ready_and_reveal`].
    pub(crate) fn placement_ready_and_reveal<F>(&self, reveal: F) -> bool
    where
        F: FnOnce() -> bool,
    {
        let mut state = self.lock_state();
        state.initial_placement_done = true;
        Self::reveal_if_ready(&mut state, reveal)
    }

    /// Record a deliberate tray hide. A later readiness fallback must not
    /// reopen a window the user has explicitly hidden.
    pub(crate) fn mark_user_hidden(&self) {
        let mut state = self.lock_state();
        state.user_hidden = true;
        if !state.initial_visibility_decided {
            state.initial_visibility_decided = true;
        }
    }

    /// Record an explicit user/tray show. This consumes the initial reveal
    /// opportunity so a later readiness callback cannot show it a second time.
    pub(crate) fn mark_user_shown(&self) {
        let mut state = self.lock_state();
        state.user_hidden = false;
        state.initial_visibility_decided = true;
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn reveal_if_ready<F>(state: &mut State, reveal: F) -> bool
    where
        F: FnOnce() -> bool,
    {
        if !state.page_ready
            || !state.initial_placement_done
            || state.user_hidden
            || state.initial_visibility_decided
        {
            return false;
        }
        // Reserve the one-shot before calling native code. If the native
        // operation fails, leave it available for the other readiness signal.
        state.initial_visibility_decided = true;
        if reveal() {
            true
        } else {
            state.initial_visibility_decided = false;
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::StartupReadiness;

    #[test]
    fn repeated_page_and_placement_signals_reveal_once_page_first() {
        let state = StartupReadiness::default();
        let reveals = std::cell::Cell::new(0);
        assert!(!state.page_ready_and_reveal(|| {
            reveals.set(reveals.get() + 1);
            true
        }));
        assert!(state.placement_ready_and_reveal(|| {
            reveals.set(reveals.get() + 1);
            true
        }));
        assert!(!state.page_ready_and_reveal(|| {
            reveals.set(reveals.get() + 1);
            true
        }));
        assert!(!state.placement_ready_and_reveal(|| {
            reveals.set(reveals.get() + 1);
            true
        }));
        assert_eq!(reveals.get(), 1);
    }

    #[test]
    fn repeated_page_and_placement_signals_reveal_once_placement_first() {
        let state = StartupReadiness::default();
        let reveals = std::cell::Cell::new(0);
        assert!(!state.placement_ready_and_reveal(|| {
            reveals.set(reveals.get() + 1);
            true
        }));
        assert!(state.page_ready_and_reveal(|| {
            reveals.set(reveals.get() + 1);
            true
        }));
        assert!(!state.placement_ready_and_reveal(|| {
            reveals.set(reveals.get() + 1);
            true
        }));
        assert!(!state.page_ready_and_reveal(|| {
            reveals.set(reveals.get() + 1);
            true
        }));
        assert_eq!(reveals.get(), 1);
    }

    #[test]
    fn failed_reveal_can_retry_after_multiple_failures_then_succeed() {
        let state = StartupReadiness::default();
        let attempts = std::cell::Cell::new(0);
        assert!(!state.placement_ready_and_reveal(|| {
            attempts.set(attempts.get() + 1);
            false
        }));
        for _ in 0..3 {
            assert!(!state.page_ready_and_reveal(|| {
                attempts.set(attempts.get() + 1);
                false
            }));
        }
        assert!(state.placement_ready_and_reveal(|| {
            attempts.set(attempts.get() + 1);
            true
        }));
        assert_eq!(attempts.get(), 4);
        assert!(!state.page_ready_and_reveal(|| {
            attempts.set(attempts.get() + 1);
            true
        }));
        assert_eq!(attempts.get(), 4);
    }

    #[test]
    fn failed_reveal_followed_by_user_hide_never_reveals() {
        let state = StartupReadiness::default();
        let reveals = std::cell::Cell::new(0);
        assert!(!state.placement_ready_and_reveal(|| {
            reveals.set(reveals.get() + 1);
            false
        }));
        assert!(!state.page_ready_and_reveal(|| {
            reveals.set(reveals.get() + 1);
            false
        }));
        state.mark_user_hidden();
        assert!(!state.placement_ready_and_reveal(|| {
            reveals.set(reveals.get() + 1);
            true
        }));
        assert_eq!(reveals.get(), 1);
    }

    #[test]
    fn hide_then_show_before_readiness_does_not_reveal_later() {
        let state = StartupReadiness::default();
        let reveals = std::cell::Cell::new(0);
        state.mark_user_hidden();
        state.mark_user_shown();
        assert!(!state.page_ready_and_reveal(|| {
            reveals.set(reveals.get() + 1);
            true
        }));
        assert!(!state.placement_ready_and_reveal(|| {
            reveals.set(reveals.get() + 1);
            true
        }));
        assert_eq!(reveals.get(), 0);
    }

    #[test]
    fn hide_then_show_after_reveal_does_not_reveal_twice() {
        let state = StartupReadiness::default();
        let reveals = std::cell::Cell::new(0);
        assert!(!state.page_ready_and_reveal(|| {
            reveals.set(reveals.get() + 1);
            true
        }));
        assert!(state.placement_ready_and_reveal(|| {
            reveals.set(reveals.get() + 1);
            true
        }));
        state.mark_user_hidden();
        state.mark_user_shown();
        assert!(!state.page_ready_and_reveal(|| {
            reveals.set(reveals.get() + 1);
            true
        }));
        assert!(!state.placement_ready_and_reveal(|| {
            reveals.set(reveals.get() + 1);
            true
        }));
        assert_eq!(reveals.get(), 1);
    }

    #[test]
    fn registers_host_ready_listener_before_building_window() {
        let source = include_str!("lib.rs");
        let listener = source
            .find("listen(\"host:ready\"")
            .expect("host:ready should be registered before the window is built");
        let build = source
            .find(".build()?")
            .expect("main window build should remain in setup");
        assert!(
            listener < build,
            "host:ready listener must be installed before the renderer can emit it"
        );
    }
}
