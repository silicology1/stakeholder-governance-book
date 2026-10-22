
```cairo

fn remove_from_evaluation(
            ref self: ContractState, evaluation_id: u256, stake_id: u256,
        ) {
            self.reentrancyguard.start();
            let caller = get_caller_address();

            let mut e = self.evaluations.entry(evaluation_id).read();
            assert(
                e.phase == PHASE_APPLYING || e.phase == PHASE_COMMIT,
                'WrongPhaseForRemoval',
            );

            let stake = self.stakes.entry(stake_id).read();
            assert(stake.owner == caller, 'NotStakeOwner');

            assert(
                self.stake_applied_to_eval.entry((stake_id, evaluation_id)).read(),
                'NotApplied',
            );

            if e.phase == PHASE_COMMIT {
                let drawn_count = e.drawn_count;
                let mut is_drawn: bool = false;
                let mut i: u32 = 0;
                loop {
                    if i >= drawn_count {
                        break;
                    }
                    let drawn_id = self
                        .evaluation_drawn_stakes
                        .entry((evaluation_id, i))
                        .read();
                    if drawn_id == stake_id {
                        is_drawn = true;
                        break;
                    }
                    i += 1;
                };
                assert(!is_drawn, 'StakeDrawn');
            }

            let fenwick_index = self
                .evaluation_stake_to_index
                .entry((evaluation_id, stake_id))
                .read();
            if fenwick_index != 0 {
                self._fenwick_sub_eval(evaluation_id, fenwick_index, stake.amount);
                self.evaluation_stake_to_index
                    .entry((evaluation_id, stake_id))
                    .write(0);
                self.evaluation_index_to_stake
                    .entry((evaluation_id, fenwick_index))
                    .write(0);
            }

            let applied_count = e.applied_count;
            let mut found: bool = false;
            let mut i: u32 = 0;
            loop {
                if i >= applied_count {
                    break;
                }
                let sid = self
                    .evaluation_applied_stakes
                    .entry((evaluation_id, i))
                    .read();
                if sid == stake_id {
                    found = true;
                    let last_idx = applied_count - 1;
                    if i != last_idx {
                        let last_sid = self
                            .evaluation_applied_stakes
                            .entry((evaluation_id, last_idx))
                            .read();
                        self.evaluation_applied_stakes
                            .entry((evaluation_id, i))
                            .write(last_sid);
                    }
                    self.evaluation_applied_stakes
                        .entry((evaluation_id, last_idx))
                        .write(0);
                    break;
                }
                i += 1;
            };
            assert(found, 'StakeNotInAppliedList');

            e.applied_count = applied_count - 1;
            self.evaluations.entry(evaluation_id).write(e);
            self.evaluation_applied_count
                .entry(evaluation_id)
                .write(e.applied_count);

            self.stake_applied_to_eval.entry((stake_id, evaluation_id)).write(false);
            let current_count = self.stake_evaluation_count.entry(stake_id).read();
            assert(current_count > 0, 'CountUnderflow');
            self.stake_evaluation_count.entry(stake_id).write(current_count - 1);

            self.emit(StakeRemoved { evaluation_id, stake_id, owner: caller });

            self.reentrancyguard.end();
        }

```

## Assistant

Let me trace through what happens:

1. `self.reentrancyguard.start();` - Reentrancy guard start
2. `let caller = get_caller_address();` - Get caller
3. Read evaluation, assert phase is APPLYING or COMMIT ('WrongPhaseForRemoval')
4. Read stake, assert caller is owner ('NotStakeOwner')
5. Assert stake is applied to this evaluation ('NotApplied')
6. If PHASE_COMMIT: verify stake wasn't drawn ('StakeDrawn') - loop through drawn stakes
7. Get fenwick_index for (evaluation_id, stake_id)
8. If fenwick_index != 0: subtract stake amount from Fenwick tree, clear both mapping directions
9. Find stake in evaluation_applied_stakes array, swap-remove it (move last element to its position, zero out last), decrement applied_count
10. Update evaluation storage and evaluation_applied_count
11. Set stake_applied_to_eval[(stake_id, evaluation_id)] = false
12. Decrement stake_evaluation_count[stake_id]
13. Emit StakeRemoved event
14. Reentrancy guard end

Let me write this out clearly.

Here's a bit-by-bit breakdown of `remove_from_evaluation` in `src/selection.cairo`.

### 1. Reentrancy guard + caller
```cairo
self.reentrancyguard.start();
let caller = get_caller_address();
```
Starts the reentrancy lock so this external call can't be re-entered while it's mid-flight (it touches token custody indirectly through stake accounting).

### 2. Read evaluation + phase check
```cairo
let mut e = self.evaluations.entry(evaluation_id).read();
assert(
    e.phase == PHASE_APPLYING || e.phase == PHASE_COMMIT,
    'WrongPhaseForRemoval',
);
```
Loads the evaluation record. Removal is only allowed while the evaluation is in `PHASE_APPLYING` (jurors still signing up) or `PHASE_COMMIT` (commit window open, but only if the juror wasn't drawn — see below). Once voting/reveal/finalization has started, stakes are locked in.

### 3. Ownership check
```cairo
let stake = self.stakes.entry(stake_id).read();
assert(stake.owner == caller, 'NotStakeOwner');
```
Only the stake's owner can withdraw it from an evaluation.

### 4. Applied check
```cairo
assert(
    self.stake_applied_to_eval.entry((stake_id, evaluation_id)).read(),
    'NotApplied',
);
```
The stake must actually be applied to this evaluation.

### 5. Commit-phase guard: not drawn
```cairo
if e.phase == PHASE_COMMIT {
    let drawn_count = e.drawn_count;
    let mut is_drawn: bool = false;
    let mut i: u32 = 0;
    loop {
        if i >= drawn_count { break; }
        let drawn_id = self.evaluation_drawn_stakes.entry((evaluation_id, i)).read();
        if drawn_id == stake_id { is_drawn = true; break; }
        i += 1;
    };
    assert(!is_drawn, 'StakeDrawn');
}
```
If we're in commit phase, the juror pool has already been drawn. A **drawn** juror can't back out (their stake is locked for the vote). This linearly scans `evaluation_drawn_stakes[0..drawn_count]` for the stake ID and reverts with `StakeDrawn` if found. (In apply phase, no draw has happened, so this check is skipped.)

### 6. Remove from Fenwick tree
```cairo
let fenwick_index = self.evaluation_stake_to_index.entry((evaluation_id, stake_id)).read();
if fenwick_index != 0 {
    self._fenwick_sub_eval(evaluation_id, fenwick_index, stake.amount);
    self.evaluation_stake_to_index.entry((evaluation_id, stake_id)).write(0);
    self.evaluation_index_to_stake.entry((evaluation_id, fenwick_index)).write(0);
}
```
Every applied stake has a position (`fenwick_index`) in the per-evaluation Fenwick tree, keyed by `stake.amount` (its weight). `_fenwick_sub_eval` subtracts that amount from every Fenwick node covering that index, so weighted draws no longer include it. Then both direction mappings are cleared:
- `evaluation_stake_to_index[(eval, stake)] → 0`
- `evaluation_index_to_stake[(eval, fenwick_index)] → 0`

The `if fenwick_index != 0` guard is because index `0` is the sentinel meaning "not indexed" (Fenwick indices start at 1).

### 7. Remove from the applied-stakes array (swap-and-pop)
```cairo
let applied_count = e.applied_count;
let mut found: bool = false;
let mut i: u32 = 0;
loop {
    if i >= applied_count { break; }
    let sid = self.evaluation_applied_stakes.entry((evaluation_id, i)).read();
    if sid == stake_id {
        found = true;
        let last_idx = applied_count - 1;
        if i != last_idx {
            let last_sid = self.evaluation_applied_stakes.entry((evaluation_id, last_idx)).read();
            self.evaluation_applied_stakes.entry((evaluation_id, i)).write(last_sid);
        }
        self.evaluation_applied_stakes.entry((evaluation_id, last_idx)).write(0);
        break;
    }
    i += 1;
};
assert(found, 'StakeNotInAppliedList');
```
`evaluation_applied_stakes[(eval, i)]` is a dense array of applied stake IDs. To remove `stake_id` at position `i`:
- Swap the last element into position `i` (unless `i` is already the last).
- Zero out the last slot.
- Break out early.

This keeps the array compact without shifting every element, O(1) amortized for the removal itself (the scan to find `i` is O(n)).

### 8. Decrement applied counts
```cairo
e.applied_count = applied_count - 1;
self.evaluations.entry(evaluation_id).write(e);
self.evaluation_applied_count.entry(evaluation_id).write(e.applied_count);
```
Both the in-memory `e` copy and the dedicated counter map are decremented and persisted.

### 9. Clear the reverse flag + juror's active-eval count
```cairo
self.stake_applied_to_eval.entry((stake_id, evaluation_id)).write(false);
let current_count = self.stake_evaluation_count.entry(stake_id).read();
assert(current_count > 0, 'CountUnderflow');
self.stake_evaluation_count.entry(stake_id).write(current_count - 1);
```
- `stake_applied_to_eval[(stake_id, evaluation_id)]` → `false` so the stake can be re-applied elsewhere later.
- `stake_evaluation_count[stake_id]` tracks how many evaluations this stake is simultaneously applied to (bounded by `max_evaluations_per_stake`). It's decremented, with an underflow assertion as a sanity check.

### 10. Event + guard end
```cairo
self.emit(StakeRemoved { evaluation_id, stake_id, owner: caller });
self.reentrancyguard.end();
```
Emits `StakeRemoved` (indexed by evaluation, stake, and owner) and releases the reentrancy lock.

---

### Summary of invariants maintained
| What | How |
|------|-----|
| **Weighted draw correctness** | Fenwick tree decremented before removal completes |
| **No double-removal** | `stake_applied_to_eval` flag checked up front |
| **No removing drawn jurors mid-vote** | `StakeDrawn` assertion in commit phase |
| **Compact applied-stake array** | Swap-and-pop keeps iteration bounded |
| **Juror's concurrent-eval limit stays accurate** | `stake_evaluation_count` decremented |
| **Ownership** | Only `stake.owner` can call |

One nuance: the function reads `stake.amount` **before** mutating anything, and uses that snapshot for the Fenwick subtraction. Since `unstake_stake` (which reduces `stake.amount`) requires `stake_evaluation_count == 0` — meaning the stake is applied to no evaluations — a stake's amount can't change while it's applied, so the snapshot is always consistent.



It's **moderately efficient** — the swap-and-pop itself is good, but there's a gas cost driver worth understanding.

### What's efficient (O(1))
Once the stake is found at index `i`, the actual removal is constant-time:
- 1 storage read (last element)
- 2 storage writes (move last element into slot `i`, zero out slot `last_idx`)
- 2 storage writes (decrement `applied_count` on the eval and on the juror)

That's swap-and-pop doing exactly what it should: avoid shifting every element after `i`.

### What costs gas (O(n))
The linear scan:
```cairo
let mut i: u32 = 0;
loop {
    if i >= applied_count { break; }
    let sid = self.evaluation_applied_stakes.entry((evaluation_id, i)).read();
    if sid == stake_id { ... break; }
    i += 1;
};
```

This reads `evaluation_applied_stakes` one slot at a time until it finds `stake_id`. In the worst case that's `applied_count` storage reads. Since `applied_count` is capped by `EVAL_FENWICK_SIZE` (10,000) and practically by how many jurors applied to that evaluation, the scan can touch thousands of storage slots.

On Starknet, storage reads are cheaper than writes, but they still consume gas — and this is a read inside a loop, so the cost grows with how many stakes are applied before the one being removed.

### Comparison to alternatives
| Approach | Reads | Writes | Notes |
|----------|-------|--------|-------|
| **Swap-and-pop (current)** | O(n) scan | O(1) | Good balance |
| Shift-down removal | O(n) scan | O(n) writes | Worse |
| Tombstone/gap | O(1) | O(1) | Leaves holes; iteration logic gets messy |
| Index map (`stake_id → position`) | O(1) | O(1) for removal + O(1) for apply | Needs extra storage bookkeeping; apply gets more expensive |

### Practical context
`remove_from_evaluation` isn't a hot-path function — it's called when a juror backs out during applying/commit, not on every vote or draw. For typical evaluations with dozens to a few hundred jurors, the gas cost is negligible. It only becomes noticeable if an evaluation has thousands of applied stakes and a late-applied juror removes theirs (scan has to walk past almost all of them).

If you wanted to optimize further, you'd add a reverse map `evaluation_stake_to_index` already exists — actually it *does* exist (`evaluation_stake_to_index[(evaluation_id, stake_id)]` stores the fenwick index, not the array position). You could store the `applied_stakes` array position too, enabling O(1) lookup + swap-and-pop, but that adds storage writes to every `apply_to_evaluation` call. Given removal is rare, the current trade-off is reasonable.

**Bottom line:** swap-and-pop is the right choice for the removal step; the gas cost comes from the unavoidable linear scan to locate the stake, which is acceptable for an infrequent user-initiated operation.
