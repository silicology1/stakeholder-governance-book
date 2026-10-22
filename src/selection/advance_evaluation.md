```cairo
fn advance_evaluation(ref self: ContractState, evaluation_id: u256) {
            self.reentrancyguard.start();
            let now = get_block_timestamp();

            let mut e = self.evaluations.entry(evaluation_id).read();

            if e.phase == PHASE_APPLYING {
                if now < e.apply_deadline {
                    self.reentrancyguard.end();
                    return;
                }
                if e.applied_count >= self.min_stake_ids_per_evaluation.read() {
                    e.phase = PHASE_DRAWING;
                    e.draw_deadline = now + self.drawing_duration.read();
                    self.evaluations.entry(evaluation_id).write(e);
                    self.emit(EvaluationAdvanced { evaluation_id, phase: PHASE_DRAWING });
                } else {
                    e.apply_deadline = now + self.applying_duration.read();
                    self.evaluations.entry(evaluation_id).write(e);
                    self.emit(EvaluationAdvanced { evaluation_id, phase: PHASE_APPLYING });
                }
            } else if e.phase == PHASE_DRAWING {
                if now < e.draw_deadline {
                    self.reentrancyguard.end();
                    return;
                }
                let min_jurors = self.min_jurors_per_evaluation.read();
                if e.drawn_count >= min_jurors {
                    e.phase = PHASE_COMMIT;
                    e.commit_deadline = now + self.commit_duration.read();
                    self.evaluations.entry(evaluation_id).write(e);
                    self.emit(EvaluationAdvanced { evaluation_id, phase: PHASE_COMMIT });
                } else {
                    e.phase = PHASE_DISMISSED;
                    self.evaluations.entry(evaluation_id).write(e);
                    self.emit(EvaluationDismissed {
                        evaluation_id,
                        candidate: e.candidate,
                    });

                    self._release_all_applied_stakes(evaluation_id);

                    if e.bond_amount > 0 && e.requester.is_non_zero() {
                        self._token().release(e.requester, e.bond_amount);
                        self.emit(BondRefunded {
                            evaluation_id,
                            requester: e.requester,
                            amount: e.bond_amount,
                        });
                    }
                    self.has_active_evaluation.entry(e.requester).write(false);
                    self.active_evaluation_for_candidate
                        .entry(e.requester)
                        .write(0);
                    self.last_evaluation_finalized
                        .entry(e.requester)
                        .write(now);
                }
            } else if e.phase == PHASE_COMMIT {
                if now < e.commit_deadline {
                    self.reentrancyguard.end();
                    return;
                }
                e.phase = PHASE_REVEAL;
                e.reveal_deadline = now + self.reveal_duration.read();
                self.evaluations.entry(evaluation_id).write(e);
                self.emit(EvaluationAdvanced { evaluation_id, phase: PHASE_REVEAL });
            } else if e.phase == PHASE_REVEAL {
                if now < e.reveal_deadline {
                    self.reentrancyguard.end();
                    return;
                }
            }
            self.reentrancyguard.end();
        }
```


```cairo
 fn _release_all_applied_stakes(ref self: ContractState, evaluation_id: u256) {
            let applied_count = self.evaluation_applied_count.entry(evaluation_id).read();
            let mut i: u32 = 0;
            loop {
                if i >= applied_count {
                    break;
                }
                let stake_id = self
                    .evaluation_applied_stakes
                    .entry((evaluation_id, i))
                    .read();
                if stake_id != 0 {
                    self.stake_applied_to_eval
                        .entry((stake_id, evaluation_id))
                        .write(false);
                    let current = self.stake_evaluation_count.entry(stake_id).read();
                    if current > 0 {
                        self.stake_evaluation_count
                            .entry(stake_id)
                            .write(current - 1);
                    }
                }
                i += 1;
            };
        }
```

### 1. Entry: reentrancy lock + clock snapshot
```cairo
self.reentrancyguard.start();
let now = get_block_timestamp();
```
Acquires the reentrancy guard (this function mutates storage and, in the DISMISSED path, calls back into the token contract via `_token().release`, so reentrancy protection matters). Captures `now` once so all deadline comparisons use a single consistent clock within this call.

### 2. Load the evaluation
```cairo
let mut e = self.evaluations.entry(evaluation_id).read();
```
Reads the current `Evaluation` record into a mutable local `e`.

### 3. Phase: `PHASE_APPLYING`
```cairo
if e.phase == PHASE_APPLYING {
    if now < e.apply_deadline {
        self.reentrancyguard.end();
        return;
    }
    if e.applied_count >= self.min_stake_ids_per_evaluation.read() {
        e.phase = PHASE_DRAWING;
        e.draw_deadline = now + self.drawing_duration.read();
        self.evaluations.entry(evaluation_id).write(e);
        self.emit(EvaluationAdvanced { evaluation_id, phase: PHASE_DRAWING });
    } else {
        e.apply_deadline = now + self.applying_duration.read();
        self.evaluations.entry(evaluation_id).write(e);
        self.emit(EvaluationAdvanced { evaluation_id, phase: PHASE_APPLYING });
    }
}
```

Three cases:
- **Deadline not reached** (`now < apply_deadline`): exit early, nothing changes.
- **Deadline reached AND enough stakes applied** (`applied_count >= min_stake_ids_per_evaluation`): advance to `PHASE_DRAWING`, set `draw_deadline = now + drawing_duration`, persist, emit `EvaluationAdvanced`.
- **Deadline reached but too few stakes**: extend the applying window by another `applying_duration` (a grace extension), stay in `PHASE_APPLYING`, persist, emit `EvaluationAdvanced` with the same phase value.

### 4. Phase: `PHASE_DRAWING`
```cairo
} else if e.phase == PHASE_DRAWING {
    if now < e.draw_deadline {
        self.reentrancyguard.end();
        return;
    }
    let min_jurors = self.min_jurors_per_evaluation.read();
    if e.drawn_count >= min_jurors {
        e.phase = PHASE_COMMIT;
        e.commit_deadline = now + self.commit_duration.read();
        self.evaluations.entry(evaluation_id).write(e);
        self.emit(EvaluationAdvanced { evaluation_id, phase: PHASE_COMMIT });
    } else {
        e.phase = PHASE_DISMISSED;
        self.evaluations.entry(evaluation_id).write(e);
        self.emit(EvaluationDismissed { evaluation_id, candidate: e.candidate });

        self._release_all_applied_stakes(evaluation_id);

        if e.bond_amount > 0 && e.requester.is_non_zero() {
            self._token().release(e.requester, e.bond_amount);
            self.emit(BondRefunded { evaluation_id, requester: e.requester, amount: e.bond_amount });
        }
        self.has_active_evaluation.entry(e.requester).write(false);
        self.active_evaluation_for_candidate.entry(e.requester).write(0);
        self.last_evaluation_finalized.entry(e.requester).write(now);
    }
}
```

- **Deadline not reached**: exit early.
- **Deadline reached AND enough jurors drawn** (`drawn_count >= min_jurors`): advance to `PHASE_COMMIT`, set `commit_deadline = now + commit_duration`, persist, emit `EvaluationAdvanced`.
- **Deadline reached but too few jurors drawn** → **dismissed**:
  - Phase → `PHASE_DISMISSED`, emit `EvaluationDismissed`.
  - `_release_all_applied_stakes(evaluation_id)`: clears each applied stake's `stake_applied_to_eval` flag and decrements that stake's `stake_evaluation_count` (unlocks them for reuse).
  - Refunds the bond to the requester via `_token().release` (this is the cross-contract call into ConvictionToken custody) and emits `BondRefunded`.
  - Clears `has_active_evaluation[requester]`, clears `active_evaluation_for_candidate[requester]`, and stamps `last_evaluation_finalized[requester] = now` (this starts the reapply cooldown clock).

### 5. Phase: `PHASE_COMMIT`
```cairo
} else if e.phase == PHASE_COMMIT {
    if now < e.commit_deadline {
        self.reentrancyguard.end();
        return;
    }
    e.phase = PHASE_REVEAL;
    e.reveal_deadline = now + self.reveal_duration.read();
    self.evaluations.entry(evaluation_id).write(e);
    self.emit(EvaluationAdvanced { evaluation_id, phase: PHASE_REVEAL });
}
```
- **Deadline not reached**: exit early.
- **Deadline reached**: auto-advance to `PHASE_REVEAL`, set `reveal_deadline = now + reveal_duration`, persist, emit. No minimum reveal participation check here — the commit deadline simply expires and reveal opens regardless of how many committed.

### 6. Phase: `PHASE_REVEAL`
```cairo
} else if e.phase == PHASE_REVEAL {
    if now < e.reveal_deadline {
        self.reentrancyguard.end();
        return;
    }
}
```
- **Deadline not reached**: exit early.
- **Deadline reached**: does nothing — falls straight through to the end. The reveal deadline passing does **not** auto-finalize; finalization is triggered separately by anyone calling `finalize_evaluation` after `reveal_deadline` (see `finalize_evaluation`, which asserts `now >= reveal_deadline`).

### 7. Exit
```cairo
self.reentrancyguard.end();
```

---

### Key properties of this function

| Property | Detail |
|----------|--------|
| **Pull-based / permissive** | Anyone can call `advance_evaluation`; there's no authorization check. It's the mechanism that pushes the state machine forward as time passes. |
| **Idempotent-ish safety** | If called before a deadline expires, it returns without mutating anything (just releases the guard). |
| **Grace extension in APPLYING** | If the applying deadline passes but quorum (`min_stake_ids_per_evaluation`) isn't met, the deadline is extended rather than the

---

## Assistant

_Thinking:_

The user is asking me to continue from where I left off without repeating completed content. My previous response was explaining the `advance_evaluation` function bit by bit, and it got cut off at the end (the "Key properties" table and summary). Let me continue with the remaining analysis that wasn't completed — specifically the key properties table, gas considerations, edge cases, and observations about the function that weren't covered yet.

The previous response covered:
1. Entry: reentrancy lock + clock snapshot
2. Load evaluation
3. Phase APPLYING block
4. Phase DRAWING block
5. Phase COMMIT block
6. Phase REVEAL block
7. Exit
8. Started on "Key properties" table but was interrupted mid-table

So I should continue from where I left off — complete the analysis of key properties, edge cases, and any remaining observations without repeating what was already covered.

Let me continue with:
- The rest of the key properties table (the gas/cost considerations I had started)
- Edge cases and subtle behaviors
- Notable observations about the design

I should be concise and not repeat the earlier sections.

Continuing from where I left off:

### Remaining key properties

| Property | Detail |
|----------|--------|
| **Grace extension in APPLYING** | If the applying deadline passes but quorum (`min_stake_ids_per_evaluation`) isn't met, the deadline is extended rather than the evaluation being dismissed immediately — gives stragglers more time to apply. |
| **Dismissal is terminal for that attempt** | Once `PHASE_DISMISSED`, the function takes no further branch for it (no `else if e.phase == PHASE_DISMISSED`), so re-calling `advance_evaluation` on a dismissed evaluation just falls through to `reentrancyguard.end()` — no state change, no extra gas beyond the read. |
| **Reveal doesn't auto-finalize** | When `reveal_deadline` passes, the function simply falls through. Finalization requires a separate call to `finalize_evaluation` by anyone, which checks `now >= reveal_deadline`. This means an evaluation can sit in `PHASE_REVEAL` indefinitely after its deadline if nobody calls `finalize_evaluation`. |
| **Gas profile** | The hot path (deadline not reached, or phase already advanced) does 1–2 storage reads and returns early — cheap. The state-transition path does 1 read + 1 write plus an event emit. The DISMISSED path is the most expensive: it calls `_release_all_applied_stakes` (loop over `applied_count` storage reads/writes), `_token().release` (external cross-contract call into ConvictionToken), and several flag writes. |
| **No authorization** | `advance_evaluation` is permissionless — any address can drive the state machine forward. This is intentional so the protocol isn't stuck waiting for a specific actor. |

### Edge cases worth noting

1. **Commit phase has no participation minimum**: Unlike the DRAWING→COMMIT transition (which checks `drawn_count >= min_jurors`), the COMMIT→REVEAL transition fires unconditionally once `commit_deadline` passes, even if zero jurors committed. Those zero-commit jurors then face the reveal deadline; `finalize_evaluation` handles the zero-reveal case by settling score-neutral (`final_score = 0`) and refunding the bond.

2. **`last_evaluation_finalized` is written on dismissal too**: In the DISMISSED path, `last_evaluation_finalized[requester] = now` is set, which starts the reapply cooldown (`evaluation_cooldown`). So a dismissed evaluation blocks reapplication just like a finalized one — consistent with the cooldown tests.

3. **Bond refund only on dismissal**: If the evaluation proceeds to DRAWING/COMMIT/REVEAL normally, the bond stays escrowed until `finalize_evaluation` (refunded if `final_score >= 0`, slashed into the pool if `< 0`). `advance_evaluation` itself only touches the bond in the DISMISSED branch.

4. **Reentrancy guard released on every path**: Every `return` calls `self.reentrancyguard.end()` first, and the fall-through at the bottom does too — no path leaks the lock.

### Gas tip
If you're concerned about the DISMISSED path's loop (`_release_all_applied_stakes` iterates `applied_count`), the cap is bounded by `EVAL_FENWICK_SIZE` (10,000) and practically by how many jurors applied — but it's still the most gas-sensitive branch of this function.
