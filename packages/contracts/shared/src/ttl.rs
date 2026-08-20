//! Shared time-to-live policy for BACKit contract storage.
//!
//! # Why this exists
//!
//! Soroban charges rent for state and evicts entries whose TTL lapses. Each
//! crate previously chose its own numbers, so the same class of record was kept
//! for very different lengths of time with no stated reason:
//!
//! | Crate | Persistent extension | Threshold |
//! |---|---|---|
//! | `call_registry` | 2_073_600 (~120 d) | 1_036_800 (~60 d) |
//! | `prediction_market` | 120_960 (~7 d) | 60_480 (~3.5 d) |
//! | `outcome_manager` | none | none |
//! | `prediction_market_futures` | none | none |
//!
//! A 17× spread between two crates holding comparable records is not a policy,
//! and two crates renewing nothing at all means their state simply expires.
//! This module replaces those numbers with named retention classes, each with
//! the reasoning attached.
//!
//! # Ledger/time assumptions
//!
//! Stellar targets a **5 second** ledger close time, so:
//!
//! ```text
//! 1 day   = 86_400 s / 5 = 17_280 ledgers
//! 7 days  =                120_960 ledgers
//! 30 days =                518_400 ledgers
//! 90 days =              1_555_200 ledgers
//! 180 days=              3_110_400 ledgers
//! ```
//!
//! Close time is a target, not a guarantee. Ledgers close slightly slower than
//! 5 s under load, which makes a ledger-denominated window **shorter in wall
//! clock terms than the nominal figure** — never longer. Every window below is
//! therefore sized with headroom rather than set to the exact requirement.
//!
//! # Rent implications
//!
//! Rent scales with entry size multiplied by the number of ledgers of TTL
//! purchased. Extending a 1 KB entry by 120 days costs roughly twice extending
//! it by 60 days. Two consequences shaped the classes below:
//!
//! 1. **Do not renew terminal records.** History that nothing will read again is
//!    pure cost. [`Retention::Historical`] exists to say so explicitly.
//! 2. **Do not renew on unauthenticated reads.** If any caller can refresh any
//!    record, storage growth is unbounded and one user's traffic subsidises
//!    everyone else's rent. See [`Retention::renew_on_read`].

#![allow(clippy::module_name_repetitions)]

use soroban_sdk::{Env, IntoVal, Val};

/// Ledgers per day at the 5 s target close time.
pub const LEDGERS_PER_DAY: u32 = 17_280;

/// Network maximum entry TTL (~180 days). An extension request above this is
/// clamped by the host, so exceeding it buys nothing while still reading as
/// intent in the source.
pub const MAX_ENTRY_TTL: u32 = 180 * LEDGERS_PER_DAY;

/// Ledgers for a whole number of days.
///
/// `const fn` so every threshold below is evaluated at compile time and the
/// arithmetic is visible at the definition rather than as a magic literal.
pub const fn days(n: u32) -> u32 {
    n * LEDGERS_PER_DAY
}

/// A renewal rule: refresh when the remaining TTL drops below `threshold`,
/// and refresh it up to `extend_to`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TtlPolicy {
    /// Renew only when live TTL falls below this. Renewing on every touch
    /// would pay rent repeatedly for TTL the entry already has.
    pub threshold: u32,
    /// Target TTL after renewal.
    pub extend_to: u32,
}

impl TtlPolicy {
    /// Both values clamped to the network maximum, so a policy can never ask
    /// for more than the host will grant.
    pub const fn clamped(self) -> Self {
        Self {
            threshold: if self.threshold > MAX_ENTRY_TTL {
                MAX_ENTRY_TTL
            } else {
                self.threshold
            },
            extend_to: if self.extend_to > MAX_ENTRY_TTL {
                MAX_ENTRY_TTL
            } else {
                self.extend_to
            },
        }
    }

    /// `threshold` below `extend_to` and both non-zero.
    ///
    /// A threshold at or above the extension renews on every single access,
    /// which is the expensive mistake this type exists to prevent.
    pub const fn is_coherent(self) -> bool {
        self.threshold > 0 && self.extend_to > self.threshold
    }
}

/// Retention classes for BACKit state.
///
/// Classification is by **required lifetime**, not by which crate owns the
/// record, so the same kind of data is retained the same way everywhere.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Retention {
    /// Admin, oracle set, fee and window configuration.
    ///
    /// Must outlive every record it governs: losing configuration while
    /// markets are still live leaves the contract unable to resolve them.
    /// Renewed on any configuration write, and on instance access, which is
    /// safe because instance storage is a single entry rather than something a
    /// caller can multiply.
    Config,

    /// Active markets, unresolved outcomes, open orders, pending disputes.
    ///
    /// Sized to cover the longest ordinary lifecycle — market open through
    /// resolution and the dispute window — with headroom for a market opened
    /// just before a quiet period.
    Active,

    /// Unclaimed payouts, refunds, and claimable balance references.
    ///
    /// The longest window in the system, and the one where expiry means a user
    /// loses money they are owed. `outcome_manager` allows a recovery address
    /// to claim on a winner's behalf only after `RecoveryGracePeriodSecs`,
    /// which defaults to 30 days from settlement. Claimable state must survive
    /// settlement, that grace period, and a further margin for the recovery
    /// claim itself.
    Claimable,

    /// Settled outcomes and closed calls kept only for history.
    ///
    /// **Never renewed.** Nothing in the contract's own logic reads these
    /// again, so paying rent to keep them is a standing cost with no
    /// beneficiary. Indexing belongs off-chain.
    Historical,
}

impl Retention {
    /// The renewal rule for this class, or `None` when the class is never
    /// renewed.
    pub const fn policy(self) -> Option<TtlPolicy> {
        match self {
            // 60 d threshold / 120 d target: preserves the value
            // `call_registry` already used, so no live deployment sees its
            // configuration retention shorten.
            Self::Config => Some(TtlPolicy {
                threshold: days(60),
                extend_to: days(120),
            }),
            // 45 d threshold / 90 d target. Comfortably covers a market plus
            // its dispute window without buying the full claim horizon for
            // records that will not need it.
            Self::Active => Some(TtlPolicy {
                threshold: days(45),
                extend_to: days(90),
            }),
            // 60 d threshold / 150 d target. Settlement plus the 30 d recovery
            // grace period plus margin, and still inside the 180 d network
            // maximum.
            Self::Claimable => Some(TtlPolicy {
                threshold: days(60),
                extend_to: days(150),
            }),
            Self::Historical => None,
        }
    }

    /// Whether a plain read may renew this class.
    ///
    /// Only [`Retention::Config`] may. Everything else is renewed by the
    /// lifecycle operations that write it, because renew-on-read lets any
    /// caller refresh any record: one address polling in a loop would keep
    /// unrelated users' state alive indefinitely and shift the rent onto the
    /// contract. `call_registry::get_call` currently does exactly this.
    pub const fn renew_on_read(self) -> bool {
        matches!(self, Self::Config)
    }
}

/// Extend a persistent entry according to its retention class.
///
/// A no-op for [`Retention::Historical`], and for a key that does not exist —
/// extending a missing entry would panic in the host, and a caller asking to
/// renew something already evicted should not bring the transaction down.
pub fn extend_persistent<K>(env: &Env, key: &K, retention: Retention)
where
    K: IntoVal<Env, Val>,
{
    let Some(policy) = retention.policy() else {
        return;
    };
    let policy = policy.clamped();

    if env.storage().persistent().has(key) {
        env.storage()
            .persistent()
            .extend_ttl(key, policy.threshold, policy.extend_to);
    }
}

/// Extend the instance entry using the [`Retention::Config`] policy.
///
/// Instance storage is one entry with one TTL, so it is always governed by the
/// longest-lived class it contains. That is also why per-user and per-market
/// records do not belong there: they cannot be retained, or expired,
/// independently of configuration.
pub fn extend_instance(env: &Env) {
    let policy = Retention::Config
        .policy()
        .expect("Config retention always has a policy")
        .clamped();

    env.storage()
        .instance()
        .extend_ttl(policy.threshold, policy.extend_to);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_day_is_17280_ledgers_at_five_seconds() {
        assert_eq!(LEDGERS_PER_DAY, 86_400 / 5);
        assert_eq!(days(1), 17_280);
        assert_eq!(days(7), 120_960);
        assert_eq!(days(30), 518_400);
    }

    #[test]
    fn network_maximum_is_180_days() {
        assert_eq!(MAX_ENTRY_TTL, 3_110_400);
    }

    #[test]
    fn every_renewable_class_has_a_coherent_policy() {
        for retention in [Retention::Config, Retention::Active, Retention::Claimable] {
            let policy = retention.policy().expect("renewable class has a policy");
            assert!(
                policy.is_coherent(),
                "{retention:?} must renew below its target, not on every access"
            );
        }
    }

    #[test]
    fn historical_state_is_never_renewed() {
        assert!(Retention::Historical.policy().is_none());
    }

    #[test]
    fn no_policy_exceeds_the_network_maximum() {
        for retention in [Retention::Config, Retention::Active, Retention::Claimable] {
            let policy = retention.policy().expect("renewable class has a policy");
            assert!(
                policy.extend_to <= MAX_ENTRY_TTL,
                "{retention:?} exceeds max"
            );
        }
    }

    #[test]
    fn clamping_caps_an_over_long_request() {
        let clamped = TtlPolicy {
            threshold: days(200),
            extend_to: days(400),
        }
        .clamped();

        assert_eq!(clamped.threshold, MAX_ENTRY_TTL);
        assert_eq!(clamped.extend_to, MAX_ENTRY_TTL);
    }

    #[test]
    fn claimable_outlives_the_recovery_grace_period() {
        // outcome_manager defaults RecoveryGracePeriodSecs to 2_592_000 s (30 d).
        // Claimable state must survive settlement plus that window plus margin.
        let grace_ledgers = 2_592_000 / 5;
        let policy = Retention::Claimable
            .policy()
            .expect("claimable is renewable");

        assert!(
            policy.extend_to > grace_ledgers,
            "claimable TTL must outlast the recovery grace period"
        );
        assert!(
            policy.threshold > grace_ledgers,
            "renewal must trigger before the grace period could lapse"
        );
    }

    #[test]
    fn claimable_is_retained_longest() {
        let claimable = Retention::Claimable.policy().unwrap().extend_to;
        let active = Retention::Active.policy().unwrap().extend_to;
        let config = Retention::Config.policy().unwrap().extend_to;

        assert!(
            claimable > active,
            "losing a payout is worse than losing a market"
        );
        assert!(claimable > config);
    }

    #[test]
    fn only_configuration_renews_on_read() {
        assert!(Retention::Config.renew_on_read());
        assert!(!Retention::Active.renew_on_read());
        assert!(!Retention::Claimable.renew_on_read());
        assert!(!Retention::Historical.renew_on_read());
    }
}
