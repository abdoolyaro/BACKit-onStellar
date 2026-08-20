//! TTL renewal behaviour for `outcome_manager` persistent state.
//!
//! These tests drive the ledger forward across the renewal thresholds defined
//! in `backit_shared::ttl` and assert what survives, what does not, and — the
//! property that matters most for rent — that one user's activity cannot keep
//! another user's records alive.

use crate::storage::{get_recovery_address_opt, set_recovery_address, PersistentKey};
use crate::{OutcomeManager, OutcomeManagerClient};
use backit_shared::ttl::{days, Retention, MAX_ENTRY_TTL};
use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, Ledger},
    Address, Env,
};

/// Read the live TTL of a persistent entry from inside the contract context.
fn persistent_ttl(env: &Env, contract: &Address, key: &PersistentKey) -> u32 {
    env.as_contract(contract, || env.storage().persistent().get_ttl(key))
}

fn setup<'a>() -> (Env, Address, OutcomeManagerClient<'a>) {
    let env = Env::default();
    env.mock_all_auths();
    // Allow entries to be extended to the full network maximum, otherwise the
    // test harness caps extensions below the policy values under test.
    env.ledger().with_mut(|l| {
        l.max_entry_ttl = MAX_ENTRY_TTL;
    });

    let contract_id = env.register(OutcomeManager, ());
    let client = OutcomeManagerClient::new(&env, &contract_id);
    (env, contract_id, client)
}

fn advance(env: &Env, ledgers: u32) {
    env.ledger().with_mut(|l| {
        l.sequence_number += ledgers;
    });
}

#[test]
fn recovery_address_is_written_with_the_claimable_ttl() {
    let (env, contract_id, _client) = setup();
    let user = Address::generate(&env);

    env.as_contract(&contract_id, || {
        set_recovery_address(&env, user.clone(), Address::generate(&env));
    });

    let policy = Retention::Claimable
        .policy()
        .expect("claimable is renewable");
    let ttl = persistent_ttl(&env, &contract_id, &PersistentKey::RecoveryAddress(user));

    assert!(
        ttl >= policy.extend_to - 1,
        "expected at least {} ledgers of TTL, found {ttl}",
        policy.extend_to
    );
}

#[test]
fn claimable_state_survives_the_recovery_grace_period() {
    let (env, contract_id, _client) = setup();
    let user = Address::generate(&env);
    let recovery = Address::generate(&env);

    env.as_contract(&contract_id, || {
        set_recovery_address(&env, user.clone(), recovery.clone());
    });

    // The recovery path unlocks 30 days after settlement. Move past it.
    advance(&env, days(31));

    let stored = env.as_contract(&contract_id, || {
        get_recovery_address_opt(&env, user.clone())
    });
    assert_eq!(
        stored,
        Some(recovery),
        "recovery designation must outlive the grace period that gates its use"
    );
}

#[test]
fn claimable_state_survives_well_beyond_the_renewal_threshold() {
    let (env, contract_id, _client) = setup();
    let user = Address::generate(&env);
    let recovery = Address::generate(&env);

    env.as_contract(&contract_id, || {
        set_recovery_address(&env, user.clone(), recovery.clone());
    });

    // Past the 60 day renewal threshold, still inside the 150 day target.
    advance(&env, days(70));

    let stored = env.as_contract(&contract_id, || {
        get_recovery_address_opt(&env, user.clone())
    });
    assert!(
        stored.is_some(),
        "entry expired before its documented window"
    );
}

/// The property that keeps rent bounded: writing one user's record must not
/// refresh another's. If it did, a single active address would subsidise
/// unbounded storage for everyone else.
#[test]
fn one_users_write_does_not_renew_another_users_record() {
    let (env, contract_id, _client) = setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    env.as_contract(&contract_id, || {
        set_recovery_address(&env, alice.clone(), Address::generate(&env));
    });

    let alice_key = PersistentKey::RecoveryAddress(alice.clone());
    let alice_ttl_before = persistent_ttl(&env, &contract_id, &alice_key);

    // Time passes, then Bob writes his own record.
    advance(&env, days(10));
    env.as_contract(&contract_id, || {
        set_recovery_address(&env, bob.clone(), Address::generate(&env));
    });

    let alice_ttl_after = persistent_ttl(&env, &contract_id, &alice_key);

    // Alice's remaining TTL must have decreased by the elapsed ledgers, not
    // been topped back up by Bob's activity.
    assert!(
        alice_ttl_after < alice_ttl_before,
        "Bob's write renewed Alice's entry: {alice_ttl_before} -> {alice_ttl_after}"
    );
    assert!(
        alice_ttl_after <= alice_ttl_before - days(10) + 1,
        "Alice's TTL did not decay by the elapsed ledgers"
    );
}

/// Reading is not a renewal. Only configuration may renew on read, and this
/// record is not configuration.
#[test]
fn reading_a_record_does_not_renew_it() {
    let (env, contract_id, _client) = setup();
    let user = Address::generate(&env);

    env.as_contract(&contract_id, || {
        set_recovery_address(&env, user.clone(), Address::generate(&env));
    });

    let key = PersistentKey::RecoveryAddress(user.clone());
    let ttl_before = persistent_ttl(&env, &contract_id, &key);

    advance(&env, days(5));
    let _ = env.as_contract(&contract_id, || {
        get_recovery_address_opt(&env, user.clone())
    });
    let ttl_after = persistent_ttl(&env, &contract_id, &key);

    assert!(
        ttl_after < ttl_before,
        "a plain read renewed the entry: {ttl_before} -> {ttl_after}"
    );
}

/// A lifecycle write renews the record **once it has fallen below the
/// threshold**. This is the counterpart to the isolation test above.
#[test]
fn rewriting_a_record_below_the_threshold_renews_it() {
    let (env, contract_id, _client) = setup();
    let user = Address::generate(&env);

    env.as_contract(&contract_id, || {
        set_recovery_address(&env, user.clone(), Address::generate(&env));
    });

    // Target is 150 days and the threshold is 60, so renewal only triggers
    // once fewer than 60 days remain — i.e. after more than 90 have passed.
    advance(&env, days(95));
    let key = PersistentKey::RecoveryAddress(user.clone());
    let ttl_decayed = persistent_ttl(&env, &contract_id, &key);

    env.as_contract(&contract_id, || {
        set_recovery_address(&env, user.clone(), Address::generate(&env));
    });
    let ttl_renewed = persistent_ttl(&env, &contract_id, &key);

    assert!(
        ttl_renewed > ttl_decayed,
        "lifecycle write below the threshold failed to renew: {ttl_decayed} -> {ttl_renewed}"
    );
}

/// Above the threshold a rewrite deliberately does **not** extend.
///
/// This is the whole point of a threshold: topping up an entry that already
/// has ample TTL pays rent for time it already owns. The first draft of the
/// test above asserted the opposite and failed, which is what pinned this down.
#[test]
fn rewriting_a_record_above_the_threshold_does_not_renew_it() {
    let (env, contract_id, _client) = setup();
    let user = Address::generate(&env);

    env.as_contract(&contract_id, || {
        set_recovery_address(&env, user.clone(), Address::generate(&env));
    });

    // Only 20 days pass, so ~130 days remain — comfortably above the 60 day
    // threshold.
    advance(&env, days(20));
    let key = PersistentKey::RecoveryAddress(user.clone());
    let ttl_before = persistent_ttl(&env, &contract_id, &key);

    env.as_contract(&contract_id, || {
        set_recovery_address(&env, user.clone(), Address::generate(&env));
    });
    let ttl_after = persistent_ttl(&env, &contract_id, &key);

    assert_eq!(
        ttl_after, ttl_before,
        "entry was topped up while it still held ample TTL, paying rent for nothing"
    );
}

#[test]
fn historical_retention_never_extends() {
    assert!(
        Retention::Historical.policy().is_none(),
        "terminal history must not be renewed; rent with no reader is pure cost"
    );
}
