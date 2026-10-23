```cairo
fn create_conviction(ref self: ContractState, level: u8, amount: u256) -> u32 {
            self.reentrancyguard.start();
            assert(level >= 1 && level <= 10, 'InvalidLevel');
            assert(amount > 0, 'ZeroAmount');
            let caller = get_caller_address();

            let total = self._decayed_total(caller);
            let locked = self.governance_locked_total.entry(caller).read();
            let available = if locked >= total {
                0
            } else {
                total - locked
            };
            assert(amount <= available, 'InsufficientGovBalance');

            self.governance_locked_total.entry(caller).write(locked + amount);

            let id = self.next_conviction_id.entry(caller).read();
            self.next_conviction_id.entry(caller).write(id + 1);

            let level_u64: u64 = level.into();
            let lock_duration: u64 = level_u64 * self.conviction_base_lock.read();
            assert(lock_duration <= MAX_LOCK_DURATION, 'LockTooLong');

            let c = Conviction {
                owner: caller,
                id,
                level,
                amount,
                created_at: get_block_timestamp(),
                lock_duration,
                votes_cast: 0,
                released: false,
            };
            self.convictions.entry((caller, id)).write(c);

            self.emit(ConvictionCreated { owner: caller, conviction_id: id, level, amount });
            self.reentrancyguard.end();
            id
        }
```


### 1. Entry: reentrancy lock
```cairo
self.reentrancyguard.start();
```
Locks the contract against reentrant calls during this external invocation.

---

### 2. Input validation
```cairo
assert(level >= 1 && level <= 10, 'InvalidLevel');
assert(amount > 0, 'ZeroAmount');
```
- **Level**: Must be between 1 and 10 inclusive. Level determines lock duration (level × base_lock) and voting power weight.
- **Amount**: Must be positive — you cannot create an empty conviction.

---

### 3. Capture caller
```cairo
let caller = get_caller_address();
```
The caller becomes the conviction owner.

---

### 4. Balance check: decayed governance balance vs. locked amount
```cairo
let total = self._decayed_total(caller);
let locked = self.governance_locked_total.entry(caller).read();
let available = if locked >= total {
    0
} else {
    total - locked
};
assert(amount <= available, 'InsufficientGovBalance');
```

**`_decayed_total`** computes the caller's current governance-token balance after hourly decay:
- Non-transferable grants decay linearly over 8,760 hours (1 year) from minting.
- Grants older than 1 year decay to zero.
- `total` = sum of all decayed grant amounts for this holder.

**`locked`** = governance tokens already locked in existing convictions.

**`available`** = `total - locked` (how much is free to lock).

If `amount > available`, the call reverts with `InsufficientGovBalance`.

---

### 5. Update locked accounting
```cairo
self.governance_locked_total.entry(caller).write(locked + amount);
```
Increases the caller's locked total by `amount`. These tokens are now locked until the conviction's lock duration expires.

---

### 6. Allocate conviction ID
```cairo
let id = self.next_conviction_id.entry(caller).read();
self.next_conviction_id.entry(caller).write(id + 1);
```
Per-owner conviction counter. Each owner gets their own sequential IDs starting from 0.

---

### 7. Compute lock duration
```cairo
let level_u64: u64 = level.into();
let lock_duration: u64 = level_u64 * self.conviction_base_lock.read();
assert(lock_duration <= MAX_LOCK_DURATION, 'LockTooLong');
```

- `conviction_base_lock` is a timelocked admin parameter (default: 9,460,800 seconds = ~109.5 days per level).
- `lock_duration = level × base_lock`.
- **Cap**: Maximum lock duration is `MAX_LOCK_DURATION` = 157,680,000 seconds (~5 years). Level 10 with default base lock would be 94,608,000 seconds (~3 years), under the cap — but if admin raises base lock, level 10 could exceed 5 years and be rejected.

---

### 8. Create and store the conviction record
```cairo
let c = Conviction {
    owner: caller,
    id,
    level,
    amount,
    created_at: get_block_timestamp(),
    lock_duration,
    votes_cast: 0,
    released: false,
};
self.convictions.entry((caller, id)).write(c);
```

| Field | Value |
|-------|-------|
| `owner` | `caller` |
| `id` | Per-owner sequential ID |
| `level` | 1–10 chosen by caller |
| `amount` | Governance tokens locked |
| `created_at` | Block timestamp at creation |
| `lock_duration` | `level × base_lock` seconds |
| `votes_cast` | `0` — no votes yet |
| `released` | `false` — stake is locked |

Stored under `convictions[(owner, id)]` — a map keyed by owner address and conviction ID.

---

### 9. Emit event
```cairo
self.emit(ConvictionCreated { owner: caller, conviction_id: id, level, amount });
```
Indexed by owner so off-chain indexers can track a holder's convictions.

---

### 10. Exit
```cairo
self.reentrancyguard.end();
id
```
Releases the lock and returns the conviction ID to the caller.

---

## Security properties

| Property | How it's enforced |
|----------|-------------------|
| No reentrancy | `reentrancyguard` wraps the entire function |
| Valid level | `1 ≤ level ≤ 10` |
| Valid amount | `amount > 0` |
| Sufficient balance | `amount ≤ decayed_total - locked` (uses decayed, not raw, balance) |
| Lock cap | `lock_duration ≤ MAX_LOCK_DURATION` (5 years) |
| Unique IDs | `next_conviction_id` incremented per owner |

---

## Key design note: voting power

A conviction's voting power is `isqrt(level × amount)` — computed at vote time in `vote_with_conviction`. Higher levels give both **more voting power** (sqrt of level) and **longer lock duration** (linear in level), creating a trade-off: lock longer for more influence, but your tokens are illiquid longer.
