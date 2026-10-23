```cairo
fn execute_proposal(ref self: ContractState, proposal_id: u256) {
            self.reentrancyguard.start();
            assert(proposal_id < self.proposal_count.read(), 'InvalidProposalId');
            let mut p = self.proposals.entry(proposal_id).read();
            assert(!p.executed, 'AlreadyExecuted');

            let total_power = p.power_total;
            assert(total_power >= self.conviction_threshold.read(), 'ThresholdNotMet');

            let voting_period = self.proposal_voting_period.read();
            assert(get_block_timestamp() >= p.created_at + voting_period, 'VotingPeriodActive');

            let final_score = self._compute_weighted_score(proposal_id);
            p.final_score = final_score;
            p.final_score_set = true;
            p.executed = true;

            let funding_wallet = p.funding_wallet;
            let deposit_amount = p.deposit_amount;
            let author = p.author;
            self.proposals.entry(proposal_id).write(p);

            self.emit(ProposalExecuted { proposal_id, total_power, final_score });

            if final_score >= 0 {
                if deposit_amount > 0 {
                    self._token().release(author, deposit_amount);
                    self
                        .emit(
                            ProposalDepositRefunded {
                                proposal_id, requester: author, amount: deposit_amount,
                            },
                        );
                }

                let score_u256 = score_to_u256(final_score);
                let rm = self.reward_multiplier.read();
                let mrm = self.mini_reward_multiplier.read();
                let reward: u256 = if score_u256 <= 3 {
                    score_u256 * mrm
                } else {
                    score_u256 * rm
                };
                if reward > 0 && self._token().mint_from_budget(funding_wallet, reward) {
                    self
                        .emit(
                            ScoreRewardReleased {
                                proposal_id, recipient: funding_wallet, amount: reward,
                            },
                        );
                }
            } else {
                if deposit_amount > 0 {
                    self
                        .emit(
                            ProposalDepositSlashed {
                                proposal_id, requester: author, amount: deposit_amount,
                            },
                        );
                }
            }

            self.reentrancyguard.end();
        }
```

### 1. Entry: reentrancy lock
```cairo
self.reentrancyguard.start();
```
Locks against reentrancy (this function makes external calls into ConvictionToken via `_token().release` and `_token().mint_from_budget`).

---

### 2. Proposal existence check
```cairo
assert(proposal_id < self.proposal_count.read(), 'InvalidProposalId');
```
The proposal must exist within the sequential ID space.

---

### 3. Load proposal + state guards
```cairo
let mut p = self.proposals.entry(proposal_id).read();
assert(!p.executed, 'AlreadyExecuted');
```
- Loads the proposal record as `mut p` because its state will change.
- Rejects if already executed — a proposal can execute only once.

---

### 4. Power threshold check
```cairo
let total_power = p.power_total;
assert(total_power >= self.conviction_threshold.read(), 'ThresholdNotMet');
```
`power_total` is the frozen accumulator of all conviction weights cast on this proposal (updated O(1) at vote time). It must meet or exceed the timelocked `conviction_threshold`. If insufficient backing, the proposal cannot execute.

---

### 5. Minimum voting period check
```cairo
let voting_period = self.proposal_voting_period.read();
assert(get_block_timestamp() >= p.created_at + voting_period, 'VotingPeriodActive');
```
The proposal must stay open for at least `voting_period` seconds (default 7 days) before execution. This prevents same-block threshold-reach-and-execute attacks.

---

### 6. Compute final score + mark executed
```cairo
let final_score = self._compute_weighted_score(proposal_id);
p.final_score = final_score;
p.final_score_set = true;
p.executed = true;
```
- `_compute_weighted_score` reads the frozen score bucket counts (proposal_score_counts) and computes a weighted average in [-5, 5].
- Marks the proposal as executed with a final score.

---

### 7. Extract fields + persist proposal
```cairo
let funding_wallet = p.funding_wallet;
let deposit_amount = p.deposit_amount;
let author = p.author;
self.proposals.entry(proposal_id).write(p);
```
Copies fields out before writing (so they're still available after the write persists the mutated struct).

---

### 8. Emit execution event
```cairo
self.emit(ProposalExecuted { proposal_id, total_power, final_score });
```
Indexed by proposal ID for off-chain tracking.

---

### 9. Score >= 0 path: refund deposit + optional reward
```cairo
if final_score >= 0 {
    if deposit_amount > 0 {
        self._token().release(author, deposit_amount);
        self.emit(ProposalDepositRefunded { proposal_id, requester: author, amount: deposit_amount });
    }

    let score_u256 = score_to_u256(final_score);
    let rm = self.reward_multiplier.read();
    let mrm = self.mini_reward_multiplier.read();
    let reward: u256 = if score_u256 <= 3 {
        score_u256 * mrm
    } else {
        score_u256 * rm
    };
    if reward > 0 && self._token().mint_from_budget(funding_wallet, reward) {
        self.emit(ScoreRewardReleased { proposal_id, recipient: funding_wallet, amount: reward });
    }
}
```

**Deposit refund:** If score is neutral or positive, the author's reputation deposit is released from ConvictionToken custody back to them.

**Reward calculation:**
- Scores 1–3 use `mini_reward_multiplier` (smaller reward).
- Scores 4–5 use `reward_multiplier` (larger reward).
- Score 0 → `score_to_u256(0) = 0` → reward = 0 → no mint.

**Reward minting:** Best-effort via `mint_from_budget` — consumes from ConvictionToken's monthly inflation/burn-recycling budget. If the budget is exhausted, the mint silently fails (no event emitted), but the proposal still executes.

---

### 10. Score < 0 path: slash deposit
```cairo
} else {
    if deposit_amount > 0 {
        self.emit(ProposalDepositSlashed { proposal_id, requester: author, amount: deposit_amount });
    }
}
```
If the final score is negative, the author's deposit is slashed. Note: the slash is **emitted as an event only** — the tokens remain in the contract's custody (they were escrowed at `create_proposal`). There's no explicit transfer to a slash pool in this function; the deposit simply stays escrowed in the token contract. The `ProposalDepositSlashed` event records the slashing.

---

### 11. Exit
```cairo
self.reentrancyguard.end();
```

---

## Summary table

| Step | Action | Revert condition |
|------|--------|-----------------|
| Guard | `reentrancyguard.start()` | — |
| Proposal exists | `proposal_id < proposal_count` | `InvalidProposalId` |
| Not executed | `!p.executed` | `AlreadyExecuted` |
| Threshold met | `power_total >= conviction_threshold` | `ThresholdNotMet` |
| Voting period elapsed | `now >= created_at + voting_period` | `VotingPeriodActive` |
| Compute score | `_compute_weighted_score(proposal_id)` | — |
| Mark executed | `executed = true`, `final_score_set = true` | — |
| Persist | Write proposal to storage | — |
| Emit | `ProposalExecuted` | — |
| Score ≥ 0 | Refund deposit, optional reward mint | — |
| Score < 0 | Slash deposit (event only) | — |
| Guard end | `reentrancyguard.end()` | — |

---

## Key design notes

- **Frozen power accumulator**: `power_total` is bumped at vote time, so `execute_proposal` reads it O(1) — no supporter registry iteration needed.
- **Best-effort reward**: If the monthly budget is empty, `mint_from_budget` returns `false`, the reward is skipped, but the proposal still executes and the deposit is still refunded.
- **Deposit stays in custody on slash**: Negative-score proposals don't transfer the deposit anywhere — it just stays in ConvictionToken custody. The `ProposalDepositSlashed` event marks it as forfeited, but the tokens aren't burned or redistributed within this function.
- **No reentrancy risk**: All state mutations happen before external token calls; `reentrancyguard` protects the sequence.
