# Storage TTL policy

Soroban charges rent for contract state and evicts entries whose time-to-live
lapses. This document records the retention classes BACKit contracts use, the
reasoning behind each, and the rent implications. The policy itself lives in
[`shared/src/ttl.rs`](shared/src/ttl.rs); this file is the narrative.

## Ledger and time assumptions

Stellar targets a **5 second** ledger close, so `1 day = 17_280 ledgers`.

Close time is a target rather than a guarantee. Under load ledgers close more
slowly, which makes a ledger-denominated window **shorter in wall-clock terms
than its nominal figure** — never longer. Every window below is therefore sized
with headroom rather than set to the exact requirement.

The network maximum entry TTL is `3_110_400` ledgers (~180 days). Requests above
it are clamped by the host, so `TtlPolicy::clamped` applies the cap in code
rather than relying on that behaviour.

## Retention classes

| Class | Threshold | Target | Applies to |
|---|---|---|---|
| `Config` | ~60 d | ~120 d | admin, oracle set, fees, windows, counters |
| `Active` | ~45 d | ~90 d | open markets, unresolved outcomes, open orders, futures positions |
| `Claimable` | ~60 d | ~150 d | unclaimed payouts and refunds, recovery designations, call records |
| `Historical` | — | never renewed | settled outcomes and closed calls kept only for history |

**`Config`** must outlive every record it governs. Losing configuration while
markets are still live leaves the contract unable to resolve them.

**`Active`** covers the longest ordinary lifecycle — open through resolution and
the dispute window — with headroom for a market opened just before a quiet
period.

**`Claimable`** is the longest window, and the only class where expiry means a
user loses money they are owed. `outcome_manager` lets a recovery address claim
on a winner's behalf only after `RecoveryGracePeriodSecs`, defaulting to 30 days
from settlement. Claimable state must survive settlement, that grace period, and
a further margin for the recovery claim itself.

**`Historical`** is never renewed, deliberately. Nothing in contract logic reads
these entries again, so paying rent to keep them is a standing cost with no
beneficiary. Indexing history belongs off-chain.

## Renewal rules

1. **Renew on lifecycle writes, not on reads.** A read-renewal lets any caller
   refresh any record: one address polling in a loop keeps unrelated users'
   state alive indefinitely and shifts the rent onto the contract. Only
   `Config` may renew on access, and only because instance storage is a single
   entry that cannot be multiplied by a caller.
2. **Renew below a threshold, not on every touch.** Topping up an entry that
   already holds ample TTL pays rent for time it already owns. `TtlPolicy`
   pairs a threshold with a target for exactly this reason, and
   `TtlPolicy::is_coherent` rejects a threshold at or above the target.
3. **Renewal is not a business event.** Extending a TTL emits nothing. A
   renewal is storage maintenance and must never be mistakable for a state
   change in an indexer.
4. **Never extend a missing entry.** `extend_persistent` checks existence
   first; extending an evicted key would trap and take down an otherwise valid
   transaction.

## Rent implications

Rent scales with entry size multiplied by ledgers of TTL purchased. Extending a
1 KB entry by 120 days costs roughly twice extending it by 60. Two consequences
shaped the classes above: terminal history is never renewed, and reads never
renew.

Changes to existing retention introduced with this policy:

| Record | Before | After | Effect |
|---|---|---|---|
| `call_registry` calls | ~120 d | ~150 d (`Claimable`) | longer; nothing expires sooner |
| `prediction_market` orders | ~7 d | ~90 d (`Active`) | **substantially longer**, and more rent |
| `outcome_manager` records | never renewed | classified and renewed | new rent where there was none |
| `prediction_market_futures` positions | never renewed | `Active` | new rent where there was none |

The `prediction_market` change is the one to weigh. Seven days is short for an
open order; an order outliving its storage entry disappears while still
notionally open. The fix costs rent, and the figure is open to maintainer
review.

## Storage inventory

### `call_registry`

Persistent: calls, staker lists, per-staker stakes, staker counts, creator
stats. Instance: config, call counter, global stats.

### `outcome_manager`

Persistent: `Votes(call_id)`, `RecoveryAddress(user)`, pending oracle
additions/removals. Instance: admin, oracle set, quorum, fee config, dispute
window, and — see the finding below — a number of per-call and per-user records.

### `prediction_market`

Persistent: orders. Instance: market configuration.

### `prediction_market_futures`

Persistent: `FuturesPosition(contract_id)`. Instance: factory address, contract
counter.

## Finding: per-entity records in instance storage

`outcome_manager` keeps several per-call and per-user records in **instance**
storage:

- `InstanceKey::FinalOutcome(u64)`
- `InstanceKey::Claimed(u64, Address)`
- `InstanceKey::ClaimableBalanceId(u64, Address)`
- `InstanceKey::SettledAt(u64)`
- `InstanceKey::PendingOutcome(u64)`
- `InstanceKey::DisputeWindowStart(u64)`

Instance storage is a **single entry with a single TTL**. That has two
consequences for this policy:

1. **Per-class retention is not expressible for that state.** Claimable payout
   records held in instance storage cannot be retained, or expired, independently
   of configuration — they live and die with the whole instance. The acceptance
   criterion "claimable payout/refund state remains live through its documented
   claim window" is therefore satisfied for these records only incidentally, by
   the instance entry's own TTL.
2. **It grows without bound.** Instance storage is size-limited, and every read
   or write loads the entire entry. Per-call and per-user keys accumulate with
   usage.

The codebase already documents the correct rule, on `PersistentKey::RecoveryAddress`:

> Per-user, so this lives in persistent (not instance) storage — see
> `PersistentKey::Votes` for the established pattern of keying per-entity
> persistent data off this enum.

`Claimed` and `ClaimableBalanceId` are per-user and do not follow it.

Moving them is a **storage migration** affecting deployed state and public
behaviour, which this issue places behind maintainer approval. It is recorded
here rather than attempted.
