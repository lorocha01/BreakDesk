//! Unattended-access password hashing (Argon2id) and brute-force lockout.

use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const MAX_FAILURES: u32 = 5;
pub const BLOCK_FOR: Duration = Duration::from_secs(15 * 60);

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("argon2: {e}"))
}

pub fn verify_password(phc: &str, password: &str) -> bool {
    match PasswordHash::new(phc) {
        Ok(h) => Argon2::default()
            .verify_password(password.as_bytes(), &h)
            .is_ok(),
        Err(_) => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthOutcome {
    Ok,
    /// Wrong password; `attempts_left` before the viewer gets blocked.
    Denied {
        attempts_left: u32,
    },
    /// Viewer is blocked (too many failures) for the given remaining time.
    Blocked {
        remaining: Duration,
    },
    /// No password configured on this host.
    NotConfigured,
}

#[derive(Default)]
struct Entry {
    failures: u32,
    blocked_until: Option<Instant>,
}

/// Tracks failed unattended logins per viewer device id. Shared across sessions.
#[derive(Default)]
pub struct AuthGuard {
    entries: Mutex<HashMap<String, Entry>>,
}

impl AuthGuard {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn blocked_remaining(&self, viewer_id: &str) -> Option<Duration> {
        self.blocked_remaining_at(viewer_id, Instant::now())
    }

    fn blocked_remaining_at(&self, viewer_id: &str, now: Instant) -> Option<Duration> {
        let map = self.entries.lock();
        map.get(viewer_id)
            .and_then(|e| e.blocked_until)
            .filter(|until| *until > now)
            .map(|until| until - now)
    }

    pub fn check(&self, viewer_id: &str, hash: Option<&str>, password: &str) -> AuthOutcome {
        self.check_at(viewer_id, hash, password, Instant::now())
    }

    pub(crate) fn check_at(
        &self,
        viewer_id: &str,
        hash: Option<&str>,
        password: &str,
        now: Instant,
    ) -> AuthOutcome {
        if let Some(remaining) = self.blocked_remaining_at(viewer_id, now) {
            return AuthOutcome::Blocked { remaining };
        }
        let Some(hash) = hash else {
            return AuthOutcome::NotConfigured;
        };
        // Verification runs outside the lock (Argon2 is intentionally slow).
        let ok = verify_password(hash, password);
        let mut map = self.entries.lock();
        let e = map.entry(viewer_id.to_string()).or_default();
        if e.blocked_until.is_some_and(|u| u <= now) {
            e.blocked_until = None;
            e.failures = 0;
        }
        if ok {
            e.failures = 0;
            return AuthOutcome::Ok;
        }
        e.failures += 1;
        if e.failures >= MAX_FAILURES {
            e.blocked_until = Some(now + BLOCK_FOR);
            e.failures = 0;
            return AuthOutcome::Blocked {
                remaining: BLOCK_FOR,
            };
        }
        AuthOutcome::Denied {
            attempts_left: MAX_FAILURES - e.failures,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_and_verify() {
        let h = hash_password("correct horse").unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert!(verify_password(&h, "correct horse"));
        assert!(!verify_password(&h, "wrong"));
        assert!(!verify_password("garbage", "x"));
    }

    #[test]
    fn lockout_after_five_failures_and_expiry() {
        let g = AuthGuard::new();
        let h = hash_password("s3cret-pass").unwrap();
        let t0 = Instant::now();
        for left in (1..MAX_FAILURES).rev() {
            assert_eq!(
                g.check_at("v1", Some(&h), "bad", t0),
                AuthOutcome::Denied {
                    attempts_left: left
                }
            );
        }
        assert!(matches!(
            g.check_at("v1", Some(&h), "bad", t0),
            AuthOutcome::Blocked { .. }
        ));
        // even the right password is refused while blocked
        assert!(matches!(
            g.check_at("v1", Some(&h), "s3cret-pass", t0),
            AuthOutcome::Blocked { .. }
        ));
        // other viewers are unaffected
        assert_eq!(
            g.check_at("v2", Some(&h), "s3cret-pass", t0),
            AuthOutcome::Ok
        );
        // after the block expires the viewer may try again
        let later = t0 + BLOCK_FOR + Duration::from_secs(1);
        assert_eq!(
            g.check_at("v1", Some(&h), "s3cret-pass", later),
            AuthOutcome::Ok
        );
        assert_eq!(
            g.check_at("v1", None, "x", later),
            AuthOutcome::NotConfigured
        );
    }

    #[test]
    fn success_resets_failures() {
        let g = AuthGuard::new();
        let h = hash_password("pw-123456").unwrap();
        let t = Instant::now();
        g.check_at("v", Some(&h), "x", t);
        g.check_at("v", Some(&h), "x", t);
        assert_eq!(g.check_at("v", Some(&h), "pw-123456", t), AuthOutcome::Ok);
        assert_eq!(
            g.check_at("v", Some(&h), "x", t),
            AuthOutcome::Denied { attempts_left: 4 }
        );
    }
}
