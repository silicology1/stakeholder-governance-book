```cairo
fn finalize_evaluation(ref self: ContractState, evaluation_id: u256) {
            self.reentrancyguard.start();
            let mut e = self.evaluations.entry(evaluation_id).read();
            assert(!e.final_score_set, 'AlreadyFinalized');
            assert(get_block_timestamp() >= e.reveal_deadline, 'RevealStillOpen');

            let drawn_count = e.drawn_count;
            let coherence_band: i64 = self.coherence_band.read().try_into().unwrap_or(1);

            let mut sum_weighted: i64 = 0;
            let mut total_weight: u32 = 0;
            let mut i: u32 = 0;
            loop {
                if i >= drawn_count {
                    break;
                }
                let stake_id = self.evaluation_drawn_stakes.entry((evaluation_id, i)).read();
                if self.evaluation_revealed.entry((evaluation_id, stake_id)).read() {
                    let score = self.evaluation_score.entry((evaluation_id, stake_id)).read();
                    let score_i64 = score_to_i64(score);
                    sum_weighted += score_i64 * SCALE;
                    total_weight += 1;
                }
                i += 1;
            }

            if total_weight == 0 {
                e.final_score = 0;
                e.final_score_set = true;
                e.phase = PHASE_FINALIZED;
                e.bond_settled = true;

                let requester = e.requester;
                let bond_to_refund = e.bond_amount;
                self.evaluations.entry(evaluation_id).write(e);

                self._finalize_cleanup(evaluation_id);

                if requester.is_non_zero() {
                    self.has_active_evaluation.entry(requester).write(false);
                    self.active_evaluation_for_candidate.entry(requester).write(0);
                    self.last_evaluation_finalized.entry(requester).write(get_block_timestamp());
                }
                if bond_to_refund > 0 {
                    self._token().release(requester, bond_to_refund);
                    self.emit(BondRefunded { evaluation_id, requester, amount: bond_to_refund });
                }

                self
                    .emit(
                        DisputeFinalized { evaluation_id, candidate: e.candidate, final_score: 0 },
                    );
                self.reentrancyguard.end();
                return;
            }

            let total_weight_i64: i64 = total_weight.try_into().unwrap_or(0);
            let mean_scaled: i64 = sum_weighted / total_weight_i64;

            let mut sum_sq: u64 = 0;
            i = 0;
            loop {
                if i >= drawn_count {
                    break;
                }
                let stake_id = self.evaluation_drawn_stakes.entry((evaluation_id, i)).read();
                if self.evaluation_revealed.entry((evaluation_id, stake_id)).read() {
                    let score = self.evaluation_score.entry((evaluation_id, stake_id)).read();
                    let score_i64 = score_to_i64(score);
                    let diff = score_i64 * SCALE - mean_scaled;
                    let diff_sq: i64 = diff * diff;
                    let diff_sq_u64: u64 = diff_sq.try_into().unwrap_or(0);
                    sum_sq += diff_sq_u64;
                }
                i += 1;
            }
            let variance_scaled: u64 = sum_sq / total_weight.try_into().unwrap_or(1);
            let stdev_scaled_u256: u256 = isqrt(variance_scaled.try_into().unwrap_or(0));
            let stdev_scaled: u64 = stdev_scaled_u256.try_into().unwrap_or(0);

            let mut sum_filtered: i64 = 0;
            let mut filtered_weight: u32 = 0;
            i = 0;
            loop {
                if i >= drawn_count {
                    break;
                }
                let stake_id = self.evaluation_drawn_stakes.entry((evaluation_id, i)).read();
                if self.evaluation_revealed.entry((evaluation_id, stake_id)).read() {
                    let score = self.evaluation_score.entry((evaluation_id, stake_id)).read();
                    let score_i64 = score_to_i64(score);
                    let diff = score_i64 * SCALE - mean_scaled;
                    let abs_diff = if diff < 0 {
                        -diff
                    } else {
                        diff
                    };
                    let stdev_scaled_i64: i64 = stdev_scaled.try_into().unwrap_or(0);
                    if abs_diff <= stdev_scaled_i64 {
                        sum_filtered += score_i64 * SCALE;
                        filtered_weight += 1;
                    }
                }
                i += 1;
            }

            let final_mean_scaled: i64 = if filtered_weight > 0 {
                let fw_i64: i64 = filtered_weight.try_into().unwrap_or(0);
                sum_filtered / fw_i64
            } else {
                mean_scaled
            };
            let final_score: i64 = round_scaled(final_mean_scaled);

            e.final_score = final_score;
            e.final_score_set = true;
            e.phase = PHASE_FINALIZED;

            let mut total_coherent_weight: u32 = 0;
            i = 0;
            loop {
                if i >= drawn_count {
                    break;
                }
                let stake_id = self.evaluation_drawn_stakes.entry((evaluation_id, i)).read();
                if self.evaluation_revealed.entry((evaluation_id, stake_id)).read() {
                    let score = self.evaluation_score.entry((evaluation_id, stake_id)).read();
                    let score_i64 = score_to_i64(score);
                    let diff = if score_i64 >= final_score {
                        score_i64 - final_score
                    } else {
                        final_score - score_i64
                    };
                    if diff <= coherence_band {
                        self.evaluation_coherent.entry((evaluation_id, stake_id)).write(true);
                        total_coherent_weight += 1;
                    }
                }
                i += 1;
            }

            let incoherence_bps: u256 = self.incoherence_slash_bps.read().try_into().unwrap_or(0);
            i = 0;
            loop {
                if i >= drawn_count {
                    break;
                }
                let stake_id = self.evaluation_drawn_stakes.entry((evaluation_id, i)).read();
                if self.evaluation_revealed.entry((evaluation_id, stake_id)).read() {
                    if !self.evaluation_coherent.entry((evaluation_id, stake_id)).read() {
                        let stake = self.stakes.entry(stake_id).read();
                        let raw_slash = stake.amount * incoherence_bps / BPS_DENOM;
                        let current_stake = self.stakes.entry(stake_id).read().amount;
                        let slash_amount = if raw_slash <= current_stake {
                            raw_slash
                        } else {
                            current_stake
                        };
                        if slash_amount > 0 {
                            self._apply_stake_slash(stake_id, slash_amount);
                            e.slash_pool += slash_amount;
                            self
                                .stake_slashed_total
                                .entry((stake_id, evaluation_id))
                                .write(slash_amount);
                            self
                                .emit(
                                    IncoherentJurorSlashed {
                                        evaluation_id, juror: stake.owner, amount: slash_amount,
                                    },
                                );
                        }
                    }
                }
                i += 1;
            }

            let juror_reward_amount = self.juror_reward_amount.read();
            let total_coherent = total_coherent_weight;

            let from_budget: bool = e.slash_pool == 0;

            if total_coherent > 0 {
                let tc_u256: u256 = total_coherent.try_into().unwrap_or(0);
                i = 0;
                loop {
                    if i >= drawn_count {
                        break;
                    }
                    let stake_id = self.evaluation_drawn_stakes.entry((evaluation_id, i)).read();
                    if self.evaluation_coherent.entry((evaluation_id, stake_id)).read() {
                        let share: u256 = if from_budget {
                            juror_reward_amount / tc_u256
                        } else {
                            e.slash_pool / tc_u256
                        };
                        self.evaluation_juror_reward.entry((evaluation_id, stake_id)).write(share);
                    }
                    i += 1;
                };
            }

            let mint_amount = governance_tokens_for_score(final_score);
            if mint_amount > 0 {
                IGovernanceDispatcher { contract_address: self.governance.read() }
                    .mint_governance_tokens(e.candidate, mint_amount);
                e.governance_tokens_minted = mint_amount;
            }

            let bond_amount = e.bond_amount;
            let requester = e.requester;
            let refund_bond = bond_amount > 0 && final_score >= 0;
            let slash_bond = bond_amount > 0 && final_score < 0;
            if slash_bond {
                e.slash_pool += bond_amount;
            }
            e.bond_settled = true;

            if requester.is_non_zero() {
                self.has_active_evaluation.entry(requester).write(false);
                self.last_evaluation_finalized.entry(requester).write(get_block_timestamp());
            }

            self.evaluations.entry(evaluation_id).write(e);
            self.emit(DisputeFinalized { evaluation_id, candidate: e.candidate, final_score });
            if mint_amount > 0 {
                self
                    .emit(
                        GovernanceTokensMinted {
                            evaluation_id, candidate: e.candidate, amount: mint_amount, final_score,
                        },
                    );
            }
            if refund_bond {
                self._token().release(requester, bond_amount);
                self.emit(BondRefunded { evaluation_id, requester, amount: bond_amount });
            } else if slash_bond {
                self.emit(BondSlashed { evaluation_id, requester, amount: bond_amount });
            }

            self._finalize_cleanup(evaluation_id);

            self.reentrancyguard.end();
        }
```

### 1. Entry: reentrancy lock + read evaluation
```cairo
self.reentrancyguard.start();
let mut e = self.evaluations.entry(evaluation_id).read();
assert(!e.final_score_set, 'AlreadyFinalized');
assert(get_block_timestamp() >= e.reveal_deadline, 'RevealStillOpen');
```
- Locks against reentrancy (this function calls into ConvictionToken and Governance).
- Loads the evaluation record as `mut e` because its state will change.
- Rejects if already finalized (`final_score_set`).
- Rejects if the reveal deadline hasn't passed yet — finalization is only allowed after reveal closes.

---

### 2. Zero-reveal early exit
```cairo
let drawn_count = e.drawn_count;
let coherence_band: i64 = self.coherence_band.read().try_into().unwrap_or(1);

let mut sum_weighted: i64 = 0;
let mut total_weight: u32 = 0;
let mut i: u32 = 0;
loop {
    if i >= drawn_count { break; }
    let stake_id = self.evaluation_drawn_stakes.entry((evaluation_id, i)).read();
    if self.evaluation_revealed.entry((evaluation_id, stake_id)).read() {
        let score = self.evaluation_score.entry((evaluation_id, stake_id)).read();
        let score_i64 = score_to_i64(score);
        sum_weighted += score_i64 * SCALE;
        total_weight += 1;
    }
    i += 1;
}

if total_weight == 0 {
    // ... early exit block ...
}
```
First pass over all drawn stakes:
- Reads each drawn stake ID, checks if it revealed, and if so accumulates `score × SCALE` (fixed-point) into `sum_weighted` and increments `total_weight`.

**If no one revealed** (`total_weight == 0`):
- Sets `final_score = 0`, `final_score_set = true`, `phase = PHASE_FINALIZED`, `bond_settled = true`.
- Writes evaluation to storage.
- Calls `_finalize_cleanup` (releases applied stakes, clears applied flags).
- Clears the candidate's active evaluation flag and stamps `last_evaluation_finalized` (starts the reapply cooldown).
- Refunds the bond to the requester via `_token().release` if `bond_amount > 0`, emits `BondRefunded`.
- Emits `DisputeFinalized` with score 0.
- Releases guard and returns early — **no scoring, no slashing, no governance minting**.

---

### 3. Weighted mean (first full pass — already done above)
Actually the mean is computed immediately after the first loop:
```cairo
let total_weight_i64: i64 = total_weight.try_into().unwrap_or(0);
let mean_scaled: i64 = sum_weighted / total_weight_i64;
```
Simple arithmetic mean of revealed scores in fixed-point (×SCALE).

---

### 4. Variance / standard deviation (second loop)
```cairo
let mut sum_sq: u64 = 0;
i = 0;
loop {
    if i >= drawn_count { break; }
    let stake_id = self.evaluation_drawn_stakes.entry((evaluation_id, i)).read();
    if self.evaluation_revealed.entry((evaluation_id, stake_id)).read() {
        let score = self.evaluation_score.entry((evaluation_id, stake_id)).read();
        let score_i64 = score_to_i64(score);
        let diff = score_i64 * SCALE - mean_scaled;
        let diff_sq: i64 = diff * diff;
        let diff_sq_u64: u64 = diff_sq.try_into().unwrap_or(0);
        sum_sq += diff_sq_u64;
    }
    i += 1;
}
let variance_scaled: u64 = sum_sq / total_weight.try_into().unwrap_or(1);
let stdev_scaled_u256: u256 = isqrt(variance_scaled.try_into().unwrap_or(0));
let stdev_scaled: u64 = stdev_scaled_u256.try_into().unwrap_or(0);
```
Second pass over revealed jurors:
- Computes squared deviation from the mean (in fixed-point).
- Accumulates into `sum_sq`.
- `variance_scaled = sum_sq / total_weight`.
- Integer square root via `isqrt` to get standard deviation (still scaled).

---

### 5. Coherence filtering / outlier removal (third loop)
```cairo
let mut sum_filtered: i64 = 0;
let mut filtered_weight: u32 = 0;
i = 0;
loop {
    if i >= drawn_count { break; }
    let stake_id = self.evaluation_drawn_stakes.entry((evaluation_id, i)).read();
    if self.evaluation_revealed.entry((evaluation_id, stake_id)).read() {
        let score = self.evaluation_score.entry((evaluation_id, stake_id)).read();
        let score_i64 = score_to_i64(score);
        let diff = score_i64 * SCALE - mean_scaled;
        let abs_diff = if diff < 0 { -diff } else { diff };
        let stdev_scaled_i64: i64 = stdev_scaled.try_into().unwrap_or(0);
        if abs_diff <= stdev_scaled_i64 {
            sum_filtered += score_i64 * SCALE;
            filtered_weight += 1;
        }
    }
    i += 1;
}

let final_mean_scaled: i64 = if filtered_weight > 0 {
    let fw_i64: i64 = filtered_weight.try_into().unwrap_or(0);
    sum_filtered / fw_i64
} else {
    mean_scaled
};
let final_score: i64 = round_scaled(final_mean_scaled);
```
Third pass:
- Keeps only jurors whose score is within 1 standard deviation of the mean (outlier filtering).
- Recomputes the mean from the filtered set.
- Falls back to the original mean if no jurors passed the filter.
- `round_scaled` converts fixed-point back to a plain integer (rounds half away from zero).
- Result: `final_score` in [-5, 5].

---

### 6. Store final score + mark phase
```cairo
e.final_score = final_score;
e.final_score_set = true;
e.phase = PHASE_FINALIZED;
```
Persists the result in memory (written to storage later at the end).

---

### 7. Coherent weight + coherence band (fourth loop)
```cairo
let mut total_coherent_weight: u32 = 0;
i = 0;
loop {
    if i >= drawn_count { break; }
    let stake_id = self.evaluation_drawn_stakes.entry((evaluation_id, i)).read();
    if self.evaluation_revealed.entry((evaluation_id, stake_id)).read() {
        let score = self.evaluation_score.entry((evaluation_id, stake_id)).read();
        let score_i64 = score_to_i64(score);
        let diff = if score_i64 >= final_score {
            score_i64 - final_score
        } else {
            final_score - score_i64
        };
        if diff <= coherence_band {
            self.evaluation_coherent.entry((evaluation_id, stake_id)).write(true);
            total_coherent_weight += 1;
        }
    }
    i += 1;
}
```
Fourth pass:
- A juror is "coherent" if their revealed score is within `coherence_band` (default 1) of the final score.
- Marks `evaluation_coherent[(eval, stake)] = true` for coherent jurors.
- Counts `total_coherent_weight` (actually a count of coherent jurors, not weight).

---

### 8. Incoherence slashing (fifth loop)
```cairo
let incoherence_bps: u256 = self.incoherence_slash_bps.read().try_into().unwrap_or(0);
i = 0;
loop {
    if i >= drawn_count { break; }
    let stake_id = self.evaluation_drawn_stakes.entry((evaluation_id, i)).read();
    if self.evaluation_revealed.entry((evaluation_id, stake_id)).read() {
        if !self.evaluation_coherent.entry((evaluation_id, stake_id)).read() {
            let stake = self.stakes.entry(stake_id).read();
            let raw_slash = stake.amount * incoherence_bps / BPS_DENOM;
            let current_stake = self.stakes.entry(stake_id).read().amount;
            let slash_amount = if raw_slash <= current_stake { raw_slash } else { current_stake };
            if slash_amount > 0 {
                self._apply_stake_slash(stake_id, slash_amount);
                e.slash_pool += slash_amount;
                self.stake_slashed_total.entry((stake_id, evaluation_id)).write(slash_amount);
                self.emit(IncoherentJurorSlashed { evaluation_id, juror: stake.owner, amount: slash_amount });
            }
        }
    }
    i += 1;
}
```
Fifth pass:
- For revealed jurors who are **not coherent**:
  - Computes raw slash = `stake.amount × incoherence_bps / 10,000`.
  - Caps at current remaining stake (can't slash more than they have).
  - Applies slash via `_apply_stake_slash` (reduces stake amount in storage).
  - Adds slashed amount to `e.slash_pool`.
  - Records per-stake slashed total.
  - Emits `IncoherentJurorSlashed`.

---

### 9. Juror reward pool determination
```cairo
let juror_reward_amount = self.juror_reward_amount.read();
let total_coherent = total_coherent_weight;

let from_budget: bool = e.slash_pool == 0;
```
- Reads the configured per-evaluation juror reward.
- `from_budget` is true if the slash pool is empty (no incoherence slashing occurred). If slashing happened, rewards are paid from the slash pool instead of the token budget.

---

### 10. Per-coherent-juror reward shares (sixth loop)
```cairo
if total_coherent > 0 {
    let tc_u256: u256 = total_coherent.try_into().unwrap_or(0);
    i = 0;
    loop {
        if i >= drawn_count { break; }
        let stake_id = self.evaluation_drawn_stakes.entry((evaluation_id, i)).read();
        if self.evaluation_coherent.entry((evaluation_id, stake_id)).read() {
            let share: u256 = if from_budget {
                juror_reward_amount / tc_u256
            } else {
                e.slash_pool / tc_u256
            };
            self.evaluation_juror_reward.entry((evaluation_id, stake_id)).write(share);
        }
        i += 1;
    };
}
```
Sixth pass:
- Divides the reward source (budget or slash pool) equally among coherent jurors.
- Writes each juror's claimable share to `evaluation_juror_reward[(eval, stake)]`.
- Jurors call `claim_juror_reward` later to actually receive it.

---

### 11. Governance token minting for candidate
```cairo
let mint_amount = governance_tokens_for_score(final_score);
if mint_amount > 0 {
    IGovernanceDispatcher { contract_address: self.governance.read() }
        .mint_governance_tokens(e.candidate, mint_amount);
    e.governance_tokens_minted = mint_amount;
}
```
- Calls `governance_tokens_for_score`:
  - Score 1 → 1,000 tokens; 2 → 2,000; 3 → 3,000; 4 → 40,000; 5 → 50,000.
  - Score ≤ 0 → 0.
- If positive, cross-contract calls `Governance.mint_governance_tokens` (selection-gated — only Selection can call this).
- Records `governance_tokens_minted` on the evaluation.

---

### 12. Bond settlement (refund or slash)
```cairo
let bond_amount = e.bond_amount;
let requester = e.requester;
let refund_bond = bond_amount > 0 && final_score >= 0;
let slash_bond = bond_amount > 0 && final_score < 0;
if slash_bond {
    e.slash_pool += bond_amount;
}
e.bond_settled = true;

if requester.is_non_zero() {
    self.has_active_evaluation.entry(requester).write(false);
    self.last_evaluation_finalized.entry(requester).write(get_block_timestamp());
}

self.evaluations.entry(evaluation_id).write(e);
```
- **Score ≥ 0**: bond is refundable (`refund_bond = true`).
- **Score < 0**: bond is slashed (`slash_bond = true`) and added to `slash_pool`.
- Marks `bond_settled = true`.
- Clears candidate's active evaluation flag, stamps `last_evaluation_finalized` (cooldown starts).
- Writes the final evaluation record to storage.

---

### 13. Events
```cairo
self.emit(DisputeFinalized { evaluation_id, candidate: e.candidate, final_score });
if mint_amount > 0 {
    self.emit(GovernanceTokensMinted { evaluation_id, candidate: e.candidate, amount: mint_amount, final_score });
}
if refund_bond {
    self._token().release(requester, bond_amount);
    self.emit(BondRefunded { evaluation_id, requester, amount: bond_amount });
} else if slash_bond {
    self.emit(BondSlashed { evaluation_id, requester, amount: bond_amount });
}
```
- Always emits `DisputeFinalized`.
- Emits `GovernanceTokensMinted` if tokens were minted.
- If refund: cross-contract `_token().release` to requester + `BondRefunded` event.
- If slash: emits `BondSlashed` (bond already added to `slash_pool` above; tokens stay in custody).

---

### 14. Cleanup + exit
```cairo
self._finalize_cleanup(evaluation_id);
self.reentrancyguard.end();
```
- `_finalize_cleanup`: iterates applied stakes, clears `stake_applied_to_eval` flags, decrements `stake_evaluation_count` per stake (unlocks them for reuse).
- Releases reentrancy lock.

---

## Summary of passes over drawn stakes

| Pass | Purpose | Storage writes |
|------|---------|----------------|
| 1 | Sum revealed scores for mean | none |
| 2 | Sum squared deviations for stddev | none |
| 3 | Filter outliers within 1 stdev | none |
| 4 | Mark coherent jurors (within band of final score) | `evaluation_coherent` writes |
| 5 | Slash incoherent jurors | `stakes`, `evaluations.slash_pool`, `stake_slashed_total`, events |
| 6 | Assign reward shares to coherent jurors | `evaluation_juror_reward` writes |

Plus cross-contract calls to ConvictionToken (bond release/slash) and Governance (token minting).
