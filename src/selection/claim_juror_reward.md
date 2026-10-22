```cairo
fn claim_juror_reward(ref self: ContractState, evaluation_id: u256, stake_id: u256) {
            self.reentrancyguard.start();
            let caller = get_caller_address();
            let e = self.evaluations.entry(evaluation_id).read();
            assert(e.final_score_set, 'NotFinalized');
            assert(self.evaluation_coherent.entry((evaluation_id, stake_id)).read(), 'NotCoherent');
            assert(
                !self.evaluation_reward_claimed.entry((evaluation_id, stake_id)).read(),
                'AlreadyClaimed',
            );
            let stake = self.stakes.entry(stake_id).read();
            assert(stake.owner == caller, 'NotStakeOwner');

            let reward = self.evaluation_juror_reward.entry((evaluation_id, stake_id)).read();
            self.evaluation_reward_claimed.entry((evaluation_id, stake_id)).write(true);

            if reward > 0 {
                let from_budget = e.slash_pool == 0;
                if from_budget {
                    if self._token().mint_from_budget(caller, reward) {
                        self
                            .emit(
                                JurorRewardClaimed { evaluation_id, juror: caller, amount: reward },
                            );
                    }
                } else {
                    self._token().release(caller, reward);
                    self.emit(JurorRewardClaimed { evaluation_id, juror: caller, amount: reward });
                }
            }

            self.reentrancyguard.end();
        }
```

### 1. Entry: reentrancy lock + caller
```cairo
self.reentrancyguard.start();
let caller = get_caller_address();
```
Acquires the reentrancy lock and captures the caller address (the juror trying to claim).

---

### 2. Evaluation must be finalized
```cairo
let e = self.evaluations.entry(evaluation_id).read();
assert(e.final_score_set, 'NotFinalized');
```
Loads the evaluation record. Rejects if the evaluation hasn't been finalized yet — there are no rewards to claim before finalization computes them.

---

### 3. Stake must be coherent
```cairo
assert(self.evaluation_coherent.entry((evaluation_id, stake_id)).read(), 'NotCoherent');
```
Only jurors marked `coherent` during finalization (score within the coherence band of the final score) can claim. Incoherent jurors were slashed, not rewarded.

---

### 4. Idempotency: not already claimed
```cairo
assert(
    !self.evaluation_reward_claimed.entry((evaluation_id, stake_id)).read(),
    'AlreadyClaimed',
);
```
Each `(evaluation_id, stake_id)` pair can claim exactly once. The `evaluation_reward_claimed` flag prevents double-payment.

---

### 5. Stake ownership check
```cairo
let stake = self.stakes.entry(stake_id).read();
assert(stake.owner == caller, 'NotStakeOwner');
```
Only the stake's owner can claim its reward. Prevents one juror from stealing another juror's reward.

---

### 6. Read the pre-computed reward share
```cairo
let reward = self.evaluation_juror_reward.entry((evaluation_id, stake_id)).read();
```
This was set during `finalize_evaluation` (sixth loop): either `juror_reward_amount / total_coherent` (from budget) or `slash_pool / total_coherent` (from slash pool).

---

### 7. Mark as claimed
```cairo
self.evaluation_reward_claimed.entry((evaluation_id, stake_id)).write(true);
```
Sets the flag **before** the payout, so even if the external token call fails/reverts, the state reflects that a claim was attempted (and the external call's atomicity handles rollback if needed).

---

### 8. Payout logic (only if reward > 0)
```cairo
if reward > 0 {
    let from_budget = e.slash_pool == 0;
```

Two paths depending on how the reward pool was funded during finalization:

**Path A — from monthly budget (no incoherence slashing occurred):**
```cairo
if from_budget {
    if self._token().mint_from_budget(caller, reward) {
        self.emit(JurorRewardClaimed { evaluation_id, juror: caller, amount: reward });
    }
}
```
- Calls ConvictionToken's `mint_from_budget` — a best-effort mint from the current month's reward budget.
- If the monthly budget is exhausted, `mint_from_budget` returns `false` and **no event is emitted**. The claim flag remains set, so the juror cannot retry (the reward simply isn't available).
- Only emits `JurorRewardClaimed` when tokens are actually minted.

**Path B — from slash pool (incoherence slashing occurred):**
```cairo
} else {
    self._token().release(caller, reward);
    self.emit(JurorRewardClaimed { evaluation_id, juror: caller, amount: reward });
}
```
- Transfers tokens from ConvictionToken custody to the caller. These tokens came from incoherent jurors' slashed stakes plus any slashed bond.
- Always emits `JurorRewardClaimed` since the release is deterministic (funds are already in the slash pool).

---

### 9. Exit
```cairo
self.reentrancyguard.end();
```
Releases the lock.

---

## Summary table

| Step | Check/Action | Revert condition |
|------|-------------|------------------|
| Guard | `reentrancyguard.start()` | — |
| Finalized | `e.final_score_set` | `NotFinalized` |
| Coherent | `evaluation_coherent[(eval, stake)]` | `NotCoherent` |
| Not claimed | `!evaluation_reward_claimed[(eval, stake)]` | `AlreadyClaimed` |
| Ownership | `stake.owner == caller` | `NotStakeOwner` |
| Payout source | `e.slash_pool == 0` → budget mint | — |
| Payout (budget) | `_token().mint_from_budget` (best-effort) | silent skip if budget empty |
| Payout (slash) | `_token().release` | — |
| Event | `JurorRewardClaimed` | only on successful mint/release |
| Guard end | `reentrancyguard.end()` | — |

## Key design notes

- **Best-effort budget mint**: If the monthly budget is empty, the claim silently fails (no event, flag still set). This prevents the whole claim from reverting due to budget constraints, but the juror loses the opportunity to claim that specific reward.
- **Cross-contract calls**: Both `_token().mint_from_budget` and `_token().release` call into ConvictionToken. Selection is registered as an authorized module, so `_assert_module()` passes.
- **Reward determined at finalize**: The actual token transfer happens at claim time, but the share amount was frozen during `finalize_evaluation`. This separates computation (finalize) from delivery (claim), allowing jurors to claim gas-efficiently when they choose.
