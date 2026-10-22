## User

When will be min_jurors are not met. Write all the codition.

---

## Assistant

So to summarize all conditions where min_jurors is NOT met:

1. **Insufficient unique stakes applied**: If fewer than `min_jurors` distinct stakes are applied to the evaluation (and none are removed during APPLYING phase), then total_weight will reach 0 before `drawn >= min_jurors`.

2. **Stakes removed during APPLYING phase**: If stakes are removed via `remove_from_evaluation` during the APPLYING phase (before drawing starts), their weight is subtracted from the Fenwick tree. If enough stakes are removed such that remaining unique stakes < `min_jurors`, then min_jurors cannot be met.

3. **`total_weight == 0` at the start of DRAWING**: If all applied stakes were removed during APPLYING, total_weight is 0 immediately when DRAWING begins.

4. **`total_weight` reaches 0 during the draw loop**: As stakes are drawn one by one, their weights are subtracted. If the number of drawable stakes is less than `min_jurors`, total_weight hits 0 mid-loop.

So really it's all one condition: **total_weight == 0 before drawn >= min_jurors**, which is caused by having fewer than `min_jurors` stakes with weight in the Fenwick tree.

I should present this clearly to the user.

Here are all the conditions where `min_jurors` is **not** met in `draw_jurors`:

## The single exit condition

The loop exits without meeting `min_jurors` when:

```cairo
let total_weight = self._fenwick_total_eval(evaluation_id);
if total_weight == 0 {
    break;  // <-- min_jurors NOT met
}
```

This means: **the Fenwick tree has no remaining weight to draw from** before `drawn >= min_jurors`.

---

## How this happens (root causes)

### 1. Fewer unique stakes applied than `min_jurors`
Each stake can only be drawn **once** per evaluation — when drawn, `_fenwick_sub_eval` removes its entire weight from the tree:

```cairo
self._fenwick_sub_eval(evaluation_id, index, stake.amount);
```

If only 3 stakes are applied but `min_jurors = 10`, the loop draws all 3, `total_weight` becomes 0, and the loop exits with `drawn = 3 < 10`.

### 2. Stakes removed during the APPLYING phase
Before drawing starts, jurors can call `remove_from_evaluation` during `PHASE_APPLYING`. That function calls:

```cairo
self._fenwick_sub_eval(evaluation_id, fenwick_index, stake.amount);
```

If enough stakes are removed before `advance_evaluation` transitions to `PHASE_DRAWING`, the remaining total weight may correspond to fewer than `min_jurors` distinct stakes.

### 3. `total_weight == 0` at the very start of DRAWING
Edge case: if every applied stake was removed during APPLYING, the Fenwick tree is empty when `draw_jurors` first runs. The loop checks `total_weight == 0` immediately and breaks with `drawn = 0`.

---

## Summary

| Scenario | Result |
|----------|--------|
| `drawn >= min_jurors` | ✅ Met → advances to `PHASE_COMMIT` |
| `total_weight == 0` before reaching `min_jurors` | ❌ Not met → stays in `PHASE_DRAWING` |

There is **no other exit path** — the loop either meets the quorum or runs out of weight. When not met, `advance_evaluation` (called separately) detects `e.drawn_count < min_jurors` in `PHASE_DRAWING` and dismisses the evaluation, refunding the bond.

---

## User

Should I provie check that there are enough stakers before moving to drawing phase.

---

## Assistant

_Thinking:_

The user is asking whether they should add a check in `advance_evaluation` (or somewhere) to ensure there are enough stakers/stakes applied before moving from APPLYING to DRAWING phase, so that `min_jurors` can actually be met during `draw_jurors`.

Let me think about this carefully based on what I read in the code.

Current flow:
1. APPLYING phase: jurors apply stakes via `apply_to_evaluation`
2. `advance_evaluation` in APPLYING phase: if `apply_deadline` passed AND `e.applied_count >= min_stake_ids_per_evaluation`, move to DRAWING
3. DRAWING phase: `draw_jurors` draws until `drawn_count >= min_jurors` or `total_weight == 0`

The issue: `advance_evaluation` checks `min_stake_ids_per_evaluation` (count of distinct stake IDs applied), NOT `min_jurors` (number of jurors needed to draw). These are different parameters:
- `min_stake_ids_per_evaluation`: minimum number of stake IDs that must be applied to move to DRAWING
- `min_jurors`: minimum number of jurors that must be drawn to move to COMMIT

So you could have 15 stake IDs applied (meeting `min_stake_ids_per_evaluation = 15`) but only 1 unique juror (if one person applied 15 stakes). Then `draw_jurors` would try to draw `min_jurors` (say 10) but after drawing that 1 juror's stake, total_weight becomes 0, and it exits with only 1 drawn < 10 min_jurors. The evaluation stays in DRAWING forever (

---

## User

Should I provide check that there are enough stakers before moving to drawing phase?

---

## Assistant

_Thinking:_

The user is asking whether they should add a check in `advance_evaluation` to ensure there are enough stakers before moving to the drawing phase. I'm in Plan mode, so I should discuss rather than implement.

Let me think through this carefully based on what I read in the code.

Current logic in `advance_evaluation` for PHASE_APPLYING → PHASE_DRAWING:
```cairo
if e.applied_count >= self.min_stake_ids_per_evaluation.read() {
    e.phase = PHASE_DRAWING;
    ...
}
```

And `draw_jurors` draws until `drawn >= min_jurors` or `total_weight == 0`.

The issue: `applied_count` counts stake IDs applied, not unique jurors. A single juror could apply multiple stake IDs. So `min_stake_ids_per_evaluation` could be met (e.g., 15 stake IDs) but all from one juror. Then `draw_jurors` would draw that one juror's stake(s), remove them from the Fenwick tree, and then `total_weight == 0` with `drawn < min_jurors`.

Wait, let me re-read `draw_jurors`. When a stake is drawn:
```cairo
self._fenwick_sub_eval(evaluation_id, index, stake.amount);
self.evaluation_stake_to_index.entry((evaluation_id, stake_id)).write(0);
self.evaluation_index_to_stake.entry((evaluation_id, index)).write(0);
```

It removes the stake from the Fenwick tree entirely. So if one juror has 15 stakes, drawing one removes one stake's weight but there are still 14 stakes left from the same juror in the tree. Actually wait - `draw_jurors` draws by stake_id. Each stake_id is a separate entry in the Fenwick tree. So if one juror applied 15 stakes, there are 15 separate entries in the Fenwick tree, each with weight STAKE. `draw_jurors` would draw them one by one, each time removing that stake_id's weight. So `drawn` would count stake draws, not unique jurors.

Actually wait, `e.drawn_count` increments per stake drawn. And `min_jurors` is compared against `drawn`. So if `min_jurors = 10` and one juror applied 15 stakes, `draw_jurors` would draw 10 stakes from that same juror and meet the threshold. But those are not 10 unique jurors.

Hmm, but actually `draw_jurors` removes the stake from the Fenwick tree after drawing. So if there are 15 stakes from one juror, drawing 10 of them leaves 5 stakes from that juror still in the tree, but `drawn = 10 >= min_jurors = 10`, so it advances to COMMIT. But those 10 draws are all from the same juror - not unique jurors.

Actually, wait. Let me re-read the Dispute struct:
```cairo
pub unique_juror_count: u32,
```

And in `get_dispute`:
```cairo
unique_juror_count: eval.drawn_count,
```

So `unique_juror_count` is actually just `drawn_count` (number of stake draws), not actually unique jurors. This is misleading naming.

So the question is: should we add a check before moving to DRAWING that ensures there are enough *unique jurors* (not just stake IDs)?

Arguments for:
- Prevents a single juror from dominating the draw (sybil resistance via multiple stakes)
- Ensures actual diversity in the jury
- Prevents the situation where `total_weight == 0` with `drawn < min_jurors` because all stakes belong to few jurors who got drawn

Arguments against:
- Adds gas cost to `advance_evaluation` (checking unique jurors requires iterating)
- The current design uses stake-weighted selection, so a juror with more stakes has proportionally more chance - this is by design
- `min_stake_ids_per_evaluation` is the configured minimum for a reason
- Adding complexity to the phase transition

Actually, the bigger issue: if `applied_count >= min_stake_ids_per_evaluation` but all stakes belong to one juror, `draw_jurors` will draw that juror's stakes until either `drawn >= min_jurors` or all their stakes are exhausted. If they have enough stakes, it advances to COMMIT with all draws from one juror. Then commit/reveal happens with one juror voting multiple times - which defeats the purpose of a jury.

Wait, but in `commit_vote` and `reveal_vote`, there's a check `_is_stake_drawn(evaluation_id, stake_id)` - so each drawn stake can vote. If one juror has 10 drawn stakes, they can vote 10 times. That's a problem.

So yes, adding a check for unique jurors before DRAWING would be good. But how to check it efficiently?

Options:
1. In `advance_evaluation` APPLYING phase, before moving to DRAWING, count unique owners among applied stakes. This requires iterating over applied stakes and checking owners - O(applied_count) gas.
2. Track unique juror count during `apply_to_evaluation` (increment when a new juror applies, decrement when removed).
3. In `draw_jurors`, track unique jurors drawn instead of just stake count, and require `unique_jurors >= min_jurors`.

I think option 2 is cleanest - maintain a running count of unique jurors applied to each evaluation. But that adds state writes to `apply_to_evaluation` and `remove_from_evaluation`.

Actually, looking more carefully: `apply_to_evaluation` already checks `stake_applied_to_eval` to prevent double-application. It could also check if this juror has already applied another stake to this evaluation, and if so, not increment a unique counter. But we'd need a mapping `juror_applied_to_eval[(juror, evaluation_id)]`.

Let me think about what to recommend. I'm in Plan mode so I should discuss, not implement.

Key points to discuss:
1. Current behavior: `min_stake_ids_per_evaluation` checks stake ID count, not unique juror count
2. Problem: one juror can apply multiple stakes and dominate the draw
3. Consequence: `draw_jurors` may exhaust all stakes from one juror and either (a) meet min_jurors with all draws from one juror, or (b) exit with drawn < min_jurors leaving evaluation stuck in DRAWING
4. Options: check unique jurors before DRAWING, track unique jurors during draw, or change `min_jurors` semantics
5. Trade-offs: gas cost vs. sybil resistance

I should present this as a discussion and ask the user what they want to do.

I'm in Plan mode, so I'll discuss rather than implement. Here's my analysis:

## Current behavior

In `advance_evaluation`, the APPLYING → DRAWING transition checks:
```cairo
if e.applied_count >= self.min_stake_ids_per_evaluation.read() {
    e.phase = PHASE_DRAWING;
    ...
}
```

`applied_count` counts **stake IDs applied**, not unique jurors. A single juror can apply multiple stake IDs (up to `max_evaluations_per_stake` globally, and multiple per evaluation).

## The problem

If `min_stake_ids_per_evaluation = 15` but all 15 stakes belong to one juror:

1. `advance_evaluation` moves to `PHASE_DRAWING` (15 stake IDs ≥ 15).
2. `draw_jurors` draws stake-weighted from the Fenwick tree. Each drawn stake is removed from the tree (`_fenwick_sub_eval`).
3. After drawing that juror's 15 stakes, `total_weight == 0` and the loop breaks.
4. If `min_jurors = 10`, `drawn = 10 ≥ 10` — it advances to COMMIT, but **all 10 draws are from the same juror**.
5. That juror can then vote 10 times in commit/reveal, dominating the outcome.

Alternatively, if the juror has fewer than `min_jurors` stakes, `draw_jurors` exits with `drawn < min_jurors` and the evaluation is stuck in `PHASE_DRAWING` forever (no more weight to draw, but quorum not met).

## Should you add the check?

**Yes, but with caveats:**

| Approach | Pros | Cons |
|----------|------|------|
| **Check unique jurors in `advance_evaluation` before DRAWING** | Prevents single-juror domination; fails fast with clear error | O(n) iteration over applied stakes to count unique owners; adds gas to phase transition |
| **Track unique juror count during `apply_to_evaluation`** | O(1) check at phase transition; no re-iteration | Extra storage writes on every apply/remove; more complex state |
| **Change `draw_jurors` to track unique jurors drawn instead of stake count** | Directly addresses the sybil issue at draw time | Doesn't prevent entering DRAWING with insufficient jurors; evaluation could still get stuck |

## My recommendation

Add a **unique juror guard** in `advance_evaluation` before transitioning to `PHASE_DRAWING`. You'd need to either:

- Iterate the applied stakes and count distinct owners at transition time (simpler, but gas-intensive), or
- Maintain a `juror_applied_to_eval` mapping and a `unique_juror_count` field on `Evaluation` (more storage, but O(1) check).

The check would be:
```cairo
if e.unique_juror_count < self.min_jurors_per_evaluation.read() {
    // reject or extend applying phase
}
```

Would you like me to switch to implementation mode and add this check?

---

## User

How much storage writes for draw_jurors to track unique jurors drawn instead of stake count.

---

## Assistant

_Thinking:_

The user is asking about the storage write cost of tracking unique jurors drawn instead of stake count in the `draw_jurors` function. Let me analyze the current code and what changes would be needed.

Currently in `draw_jurors`:
- `drawn` is a u32 count of stake IDs drawn
- The loop condition is `if drawn >= min_jurors { break; }`
- Each draw: `self.evaluation_drawn_stakes.entry((evaluation_id, drawn)).write(stake_id);` then `drawn += 1;`
- At the end: `e.drawn_count = drawn; self.evaluations.entry(evaluation_id).write(e); self.evaluation_draw_index.entry(evaluation_id).write(draw_idx);`

If tracking unique jurors instead of stake count:
- We'd need to know which juror (owner) each stake belongs to
- We'd need to track how many unique jurors have been drawn
- The loop condition would be `if unique_jurors_drawn >= min_jurors { break; }`
- When a stake is drawn, we need to check if its owner has already been drawn
- We'd need a mapping to track if a juror has been drawn for this evaluation: something like `evaluation_drawn_juror: Map<(evaluation_id, juror), bool>`

Storage writes per successful unique juror draw:
1. `evaluation_drawn_juror.entry((evaluation_id, owner)).write(true)` - mark juror as drawn
2. `evaluation_drawn_stakes.entry((evaluation_id, drawn_index)).write(stake_id)` - record stake drawn (already exists)
3. `evaluation_fenwick` writes via `_fenwick_sub_eval` - multiple writes (O(log size)) - already exists
4. `evaluation_stake_to_index` write - already exists
5. `evaluation_index_to_stake` write - already exists
6. `e.drawn_count` or `e.unique_juror_count` write to evaluations map - already exists (1 write)
7. `evaluation_draw_index` write - already exists (1 write)

Additional storage writes for tracking unique jurors:
- `evaluation_drawn_juror.entry((evaluation_id, owner)).write(true)` - 1 new write per unique juror

Wait, but the user is asking specifically about "how much storage writes" - they want to know the gas/storage cost implication.

Let me think about this more carefully. Currently:
- `drawn` counts total stakes drawn (could be multiple stakes from same juror)
- If we track unique jurors, we need:
  1. A way to check if a juror has already been drawn for this evaluation
  2. A counter for unique jurors drawn

New storage needed:
- `Map<(u256, ContractAddress), bool> evaluation_drawn_juror;` or similar - to track if a juror address has been drawn
- In Evaluation struct: add `unique_juror_count: u32` field

Per draw attempt (whether unique or duplicate):
- Read `evaluation_drawn_juror.entry((evaluation_id, owner)).read()` to check if already drawn
- If not drawn: write `evaluation_drawn_juror.entry((evaluation_id, owner)).write(true)` - 1 write
- Write `evaluation_drawn_stakes` - 1 write (already exists)
- `unique_juror_count` increment in Evaluation struct - part of the final write to `evaluations` map

Wait, but `evaluations.entry(evaluation_id).write(e)` happens once at the end, not per draw. So `unique_juror_count` doesn't add extra writes beyond what already exists for `drawn_count`.

Actually, looking more carefully at the code:
```cairo
self.evaluation_drawn_stakes.entry((evaluation_id, drawn)).write(stake_id);
drawn += 1;
```

If we change `drawn` to count unique jurors instead of stakes:
- We still write to `evaluation_drawn_stakes` but the index might not correspond 1:1 to drawn count anymore
- Actually, we might need to separate the concepts: `drawn_stakes_count` vs `unique_jurors_count`

Let me think about the storage write count:

Current per successful draw:
1. `_fenwick_sub_eval` - multiple writes (O(log N) where N=10000, roughly up to ~14 writes)
2. `evaluation_stake_to_index.write(0)` - 1 write
3. `evaluation_index_to_stake.write(0)` - 1 write
4. `evaluation_drawn_stakes.write(stake_id)` - 1 write
5. Final: `evaluations.write(e)` - 1 write (includes drawn_count)
6. `evaluation_draw_index.write(draw_idx)` - 1 write

New per unique juror draw (additional):
7. `evaluation_drawn_juror.write(true)` - 1 new write per unique juror

If a stake from an already-drawn juror is selected:
- We'd skip it (don't count toward unique jurors)
- But we still removed it from Fenwick tree, so we'd need to... hmm, this gets complicated.

Actually, the user is asking "how much storage writes" - they want a rough estimate of the additional storage write cost.

I should give them a clear breakdown:
- Current: ~3-4 storage writes per drawn stake (excluding Fenwick tree operations which are O(log N))
- Additional for unique juror tracking: +1 storage write per unique juror (the `evaluation_drawn_juror` map write)
- Plus 1 storage read per draw to check if juror already drawn
- The Fenwick tree operations remain the same

But wait - if we change from counting stakes to counting unique jurors, and a juror has multiple stakes, we might draw more stakes than `min_jurors` to get enough unique jurors. This could increase total writes.

Let me be more precise and honest about the complexity. I should not write code (Plan mode), just discuss.

Actually wait, looking at the system reminder: "You are in Plan mode... Do not modify any other files or ask a subagent to do so."

So I should just discuss and not provide code changes.

Let me give a clear answer about storage write counts.

I'm in Plan mode, so I'll discuss rather than implement.

## Storage write breakdown for `draw_jurors`

### Current writes per successfully drawn stake:
| Write | Purpose | Count per draw |
|-------|---------|----------------|
| `_fenwick_sub_eval` | Remove weight from Fenwick tree | ~1–14 (O(log N), N=10,000) |
| `evaluation_stake_to_index` | Clear stake→index mapping | 1 |
| `evaluation_index_to_stake` | Clear index→stake mapping | 1 |
| `evaluation_drawn_stakes` | Record drawn stake ID | 1 |
| `evaluations` (via `e`) | Update `drawn_count` at end | 1 (batched at end) |
| `evaluation_draw_index` | Track draw index | 1 (batched at end) |

**Fixed writes per draw:** ~3 storage writes + Fenwick writes  
**Per evaluation (batched):** 2 storage writes

---

### Additional writes to track unique jurors instead of stake count

You'd need a new map to mark a juror as already drawn:
```cairo
evaluation_drawn_juror: Map<(u256, ContractAddress), bool>,
```

And optionally a `unique_juror_count: u32` field on `Evaluation`.

**New writes per *unique* juror:**
| Write | Purpose | Count |
|-------|---------|-------|
| `evaluation_drawn_juror.write(true)` | Mark juror as drawn | +1 |

**New reads per draw attempt:**
| Read | Purpose | Count |
|------|---------|-------|
| `evaluation_drawn_juror.read()` | Check if juror already drawn | +1 per stake drawn |

---

### Bottom line

- **+1 storage write** for each *unique* juror drawn (the juror-flag map write).
- **+1 storage read** for every stake considered (to check if that juror already has a drawn stake).
- If a juror holds multiple stakes and their second stake is drawn, you'd skip counting it (no new juror-flag write), but you still paid the read and the Fenwick removal writes.

**Trade-off:** You'd likely draw *more* stakes total to reach `min_jurors` unique jurors (since duplicate jurors are skipped), which increases total Fenwick writes and `evaluation_drawn_stakes` writes. The gas cost goes up, but you prevent one juror from dominating the draw.

---

## User

What if I stop same juror to apply multiple times (apply_to_evaluation)  with different stake ids

---

## Assistant

_Thinking:_

The user is asking what would happen if they prevented the same juror from applying multiple stake IDs to the same evaluation in `apply_to_evaluation`. This is an architectural question about the contract design.

Let me think through the implications based on what I've read in the code:

Current behavior in `apply_to_evaluation`:
- A juror can apply multiple stake IDs to the same evaluation
- `stake_applied_to_eval[(stake_id, evaluation_id)]` prevents the same stake_id from being applied twice to the same evaluation
- `stake_evaluation_count[stake_id]` tracks how many evaluations a stake is applied to (max_evaluations_per_stake)
- There's NO check preventing the same *juror/owner* from applying multiple different stake IDs to the same evaluation

If the user stops the same juror from applying multiple stake IDs to the same evaluation:

1. **`apply_to_evaluation` changes**: Need to add a check like `evaluation_applied_juror[(evaluation_id, juror)]` or similar mapping to prevent a juror from applying more than one stake to the same evaluation.

2. **Impact on `draw_jurors`**: If each juror can only apply one stake, then unique jurors drawn == stakes drawn (assuming each stake belongs to a distinct juror). This simplifies the unique juror tracking discussed earlier.

3. **Impact on `min_stake_ids_per_evaluation` vs `min_jurors`**: Currently `advance_evaluation` checks `applied_count >= min_stake_ids_per_evaluation` to move to DRAWING. If each juror = 1 stake, then `applied_count` effectively equals unique juror count. So checking `applied_count >= min_stake_ids_per_evaluation` becomes equivalent to checking unique jurors >= min_stake_ids_per_evaluation. But `min_jurors` is the draw target. These could still diverge if `min_stake_ids_per_evaluation < min_jurors`.

4. **Impact on Fenwick tree**: Each juror contributes exactly one weight entry. Simpler.

5. **Impact on slashing/rewards**: Each drawn stake = one juror. No juror can have multiple votes in the same evaluation via multiple stakes.

6. **Gas implications**: 
   - Need an additional map write in `apply_to_evaluation`: `evaluation_applied_juror[(evaluation_id, owner)] = true`
   - Need to clear it in `remove_from_evaluation` and `_release_all_applied_stakes` and `_finalize_cleanup`
   - `draw_jurors` becomes simpler - no need to track unique jurors separately since each stake = one juror

Let me give a thorough analysis of pros and cons.

Pros:
- Prevents sybil-like behavior where one juror dominates with multiple stakes
- Simplifies `draw_jurors` (no need for unique juror tracking map)
- `min_stake_ids_per_evaluation` effectively becomes a min unique jurors check
- Each juror gets exactly one vote weight in the evaluation

Cons:
- Jurors with multiple stakes must choose which stake to apply (or split across evaluations)
- More complex `apply_to_evaluation` and cleanup logic
- Reduces flexibility for jurors who want to diversify across multiple stakes in one evaluation
- Additional storage writes in apply/remove/finalize

I should present this clearly without implementing anything (Plan mode).

I'm in Plan mode, so I'll discuss rather than implement.

## What changes if you block multiple stake IDs per juror per evaluation

### 1. `apply_to_evaluation` needs a new guard
You'd add a mapping like `evaluation_applied_juror[(evaluation_id, juror)]` and assert it's `false` before allowing the apply. On success, write `true`.

### 2. Cleanup must also clear that flag
In `remove_from_evaluation`, `_release_all_applied_stakes`, and `_finalize_cleanup`, you'd need to reset `evaluation_applied_juror[(evaluation_id, owner)] = false` when a stake is removed — otherwise a juror could never re-apply to that evaluation after their stake is removed.

### 3. Impact on `draw_jurors`
If each juror can contribute at most one stake to an evaluation, then **unique jurors drawn == stakes drawn** (assuming every stake has a distinct owner). This means:

- You no longer need a separate `evaluation_drawn_juror` map to prevent the same juror from being drawn twice.
- `drawn_count` effectively equals `unique_juror_count`.
- The draw loop naturally stops when `drawn_count >= min_jurors` and you're guaranteed `min_jurors` distinct jurors (provided enough unique jurors applied).

### 4. Impact on `advance_evaluation` phase transition
Currently it checks:
```cairo
if e.applied_count >= self.min_stake_ids_per_evaluation.read() {
    e.phase = PHASE_DRAWING;
```

With one-stake-per-juror, `applied_count` equals the number of unique jurors applied. So this check becomes a de facto minimum-unique-jurors check. You could keep it, or rename the parameter for clarity.

### 5. Pros and cons

| Pros | Cons |
|------|------|
| Prevents one juror from dominating an evaluation with multiple stakes | Jurors with multiple stakes must pick which stake to apply (can't diversify within one evaluation) |
| Simplifies `draw_jurors` — no unique-juror tracking map needed | More storage writes: +1 map write on apply, +1 map clear on remove/finalize |
| `applied_count` == unique juror count, so phase-transition check is meaningful | Reduces flexibility for large stakers who want to split weight across multiple stakes in a single evaluation |
| Each juror gets exactly one vote/reward in the evaluation | Slightly more complex cleanup logic across three functions |

## Recommendation

If your goal is to prevent a single juror from skewing the draw, blocking multiple stake IDs per juror per evaluation is cleaner than tracking unique jurors during the draw. It moves the enforcement to `apply_to_evaluation` (O(1) check) rather than making `draw_jurors` handle duplicates.

However, it does restrict juror flexibility. If you want to keep that flexibility but still prevent draw domination, the alternative is to allow multiple stakes per juror but skip already-drawn jurors in `draw_jurors` (the `+1 read / +1 write` per juror approach discussed earlier).
