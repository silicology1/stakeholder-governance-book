```cairo
fn release_conviction(ref self: ContractState, conviction_id: u32) {
            self.reentrancyguard.start();
            let caller = get_caller_address();
            let mut c = self.convictions.entry((caller, conviction_id)).read();
            assert(c.owner == caller, 'Unauthorized');
            assert(!c.released, 'AlreadyReleased');
            let lock_expiry = c.created_at + c.lock_duration;
            assert(get_block_timestamp() >= lock_expiry, 'LockNotExpired');

            let amount = c.amount;
            let locked = self.governance_locked_total.entry(caller).read();
            assert(locked >= amount, 'LockAccountingError');
            self.governance_locked_total.entry(caller).write(locked - amount);

            c.released = true;
            self.convictions.entry((caller, conviction_id)).write(c);

            self.emit(ConvictionReleased { owner: caller, conviction_id, amount });
            self.reentrancyguard.end();
        }
```


### 1. Entry: reentrancy lock + caller
```cairo
self.reentrancyguard.start();
let caller = get_caller_address();
```
Acquires the reentrancy guard (this function mutates governance-locked accounting). Captures the caller — only the conviction owner can release it.

---

### 2. Load conviction + ownership check
```cairo
let mut c = self.convictions.entry((caller, conviction_id)).read();
assert(c.owner == caller, 'Unauthorized');
```
Reads the conviction record keyed by `(owner, conviction_id)`. Asserts the caller is the actual owner — prevents one holder from releasing another's conviction.

---

### 3. Already released check
```cairo
assert(!c.released, 'AlreadyReleased');
```
A conviction can be released only once. If `released` is already `true`, the call reverts.

---

### 4. Lock expiry check
```cairo
let lock_expiry = c.created_at + c.lock_duration;
assert(get_block_timestamp() >= lock_expiry, 'LockNotExpired');
```
The conviction's lock duration (`level × conviction_base_lock`) must have fully elapsed since creation. If the lock is still active, the call reverts with `LockNotExpired`.

---

### 5. Update locked accounting
```cairo
let amount = c.amount;
let locked = self.governance_locked_total.entry(caller).read();
assert(locked >= amount, 'LockAccountingError');
self.governance_locked_total.entry(caller).write(locked - amount);
```
- Reads the conviction's `amount` (the governance tokens locked).
- Reads the caller's total locked governance balance.
- Asserts the locked balance is at least `amount` (sanity check — should always be true).
- Decrements the caller's `governance_locked_total` by `amount`, freeing those tokens.

---

### 6. Mark conviction as released
```cairo
c.released = true;
self.convictions.entry((caller, conviction_id)).write(c);
```
Sets `released = true` on the conviction record and persists it. This prevents future release attempts (`AlreadyReleased`) and future votes (the `vote_with_conviction` function checks `!c.released`).

---

### 7. Emit event
```cairo
self.emit(ConvictionReleased { owner: caller, conviction_id, amount });
```
Emits an indexed event so off-chain indexers can track conviction releases.

---

### 8. Exit
```cairo
self.reentrancyguard.end();
```
Releases the reentrancy lock.

---

## Summary table

| Step | Action | Revert condition |
|------|--------|-----------------|
| Guard | `reentrancyguard.start()` | — |
| Load + owner check | Read conviction, assert owner | `Unauthorized` |
| Not released | `!c.released` | `AlreadyReleased` |
| Lock expired | `now >= created_at + lock_duration` | `LockNotExpired` |
| Decrement locked | `governance_locked_total -= amount` | `LockAccountingError` |
| Mark released | `c.released = true`, write to storage | — |
| Event | `ConvictionReleased` | — |
| Guard end | `reentrancyguard.end()` | — |

---

## Key design notes

- **Released votes still count**: A released conviction's previously cast votes remain counted in proposal `power_total`. The `get_conviction_power` view returns `_vote_weight(@c)` even after release (it doesn't check `released`). This means a conviction's voting power is "frozen" at vote time and doesn't get removed when the lock expires — the vote power was already added to `power_total` at vote time.
- **Tokens become available again**: After release, `governance_locked_total` decreases, so `governance_available` (decayed total minus locked) increases. The holder can use those tokens for new convictions or other purposes.
- **No automatic release**: The holder must explicitly call `release_conviction` after the lock expires. There's no auto-unlock mechanism.
