# Replay: asymmetric-fencing

> The path a knowledgeable pair programmer would take to land the asymmetric-fencing
> fix. Not a transcript of the sandbox session. The guide is canonical; the bytes
> below are the real sandbox bytes the engine projects.

## Overview

**Built:** A grace band on the lease-fencing check so a leader is not fenced out the
instant its lease reads expired on a skewed clock. Symmetric fencing elects a second
leader under clock skew alone; the fix makes the boundary asymmetric.

## System Invariants

- **Single writer:** Two nodes that fence at once is split-brain: both believe they hold the lease and both accept writes. `must_fence` has to be the one place that cannot be wrong about this.
- **No two leaders:** Under clock skew a follower whose clock runs fast could fence a still-valid leader. The threshold must be conservative, not symmetric, or skew alone elects a second leader.

## Phase 1: Fencing fix

### Step 1.1: must_fence — add the lease grace band

**File:** `src/raft/lease.rs:42`
**Action:** Modify
**Symbol:** `must_fence`
**Invariants:** Single writer, No two leaders

**Why:** Symmetric fencing (`lease_expiry < now`) fences a leader out the instant its
lease reads expired on a skewed clock. Adding `LEASE_GRACE` widens the boundary so a
small skew can no longer elect a second leader. A single-line replace inside the loop.

**Retrospective:** What happens to the lease if the clock drifts past the TTL before the follower checks?

**Before:**
```rust
fn must_fence(&self, now: Timestamp) -> bool {
    for peer in &self.peers {
        if peer.lease_expiry < now {
            return true;
        }
    }
    false
}
```

**After:**
```rust
fn must_fence(&self, now: Timestamp) -> bool {
    for peer in &self.peers {
        if peer.lease_expiry + LEASE_GRACE < now {
            return true;
        }
    }
    false
}
```

### Step 1.2: must_fence — collapse to an iterator chain

**File:** `src/raft/lease.rs:42`
**Action:** Modify
**Symbol:** `must_fence`
**Invariants:** Single writer

**Why:** The for/if/return loop is the same predicate as a single `any` over the peers.
The control-flow skeleton is gone, so the classifier routes this to clear-and-rewrite —
you read the new shape whole, not a pile of hunks.

**Retrospective:** Does `any` short-circuit on the first expired peer the way the early `return true` did, or does it scan them all?

**Before:**
```rust
fn must_fence(&self, now: Timestamp) -> bool {
    for peer in &self.peers {
        if peer.lease_expiry + LEASE_GRACE < now {
            return true;
        }
    }
    false
}
```

**After:**
```rust
fn must_fence(&self, now: Timestamp) -> bool {
    self.peers
        .iter()
        .any(|peer| peer.lease_expiry + LEASE_GRACE < now)
}
```
