```cairo
fn slash_non_revealer(ref self: ContractState, evaluation_id: u256, stake_id: u256) {
            self.reentrancyguard.start();
            let e = self.evaluations.entry(evaluation_id).read();
            assert(get_block_timestamp() >= e.reveal_deadline, 'RevealStillOpen');

            assert(self._is_stake_drawn(evaluation_id, stake_id), 'NotDrawnStake');
            assert(!self.evaluation_revealed.entry((evaluation_id, stake_id)).read(), 'DidReveal');
            assert(
                !self.evaluation_slashed.entry((evaluation_id, stake_id)).read(), 'AlreadySlashed',
            );

            let stake = self.stakes.entry(stake_id).read();
            let owner = stake.owner;
            let bps: u256 = self.non_reveal_slash_bps.read().try_into().unwrap_or(0);
            let slash_amount = stake.amount * bps / BPS_DENOM;

            if slash_amount > 0 {
                self._apply_stake_slash(stake_id, slash_amount);

                let mut dm = self.evaluations.entry(evaluation_id).read();
                dm.slash_pool += slash_amount;
                self.evaluations.entry(evaluation_id).write(dm);

                self.stake_slashed_total.entry((stake_id, evaluation_id)).write(slash_amount);
            }

            self.evaluation_slashed.entry((evaluation_id, stake_id)).write(true);

            self.emit(JurorSlashed { evaluation_id, juror: owner, amount: slash_amount });

            let caller = get_caller_address();
            if caller != owner
                && SLASH_KEEPER_REWARD > 0
                && self._token().mint_from_budget(caller, SLASH_KEEPER_REWARD) {
                self
                    .emit(
                        SlashKeeperRewarded {
                            caller, juror: owner, evaluation_id, reward: SLASH_KEEPER_REWARD,
                        },
                    );
            }

            self.reentrancyguard.end();
        }
```


### 1. Entry: reentrancy lock + read evaluation
```cairo
self.reentrancyguard.start();
let e = self.evaluations.entry(evaluation_id).read();
```
Starts the reentrancy guard (this function mutates stake storage and calls into the token contract via `_token().mint_from_budget` for the keeper reward, so protection matters). Loads the evaluation record.

### 2. Reveal deadline must have passed
```cairo
assert(get_block_timestamp() >= e.reveal_deadline, 'RevealStillOpen');
```
Slashing a non-revealer is only allowed after the reveal window closes. If the reveal deadline hasn't passed yet, the call reverts. This ensures jurors have the full reveal window before anyone can punish them for non-participation.

### 3. Validation checks (all three must pass)
```cairo
assert(self._is_stake_drawn(evaluation_id, stake_id), 'NotDrawnStake');
```
Only a stake that was actually drawn for this evaluation can be slashed. Undrawn stakes are irrelevant to this evaluation.

```cairo
assert(!self.evaluation_revealed.entry((evaluation_id, stake_id)).read(), 'DidReveal');
```
The stake must not have revealed a vote. If they revealed, they cannot be slashed for non-revelation.

```cairo
assert(
    !self.evaluation_slashed.entry((evaluation_id, stake_id)).read(), 'AlreadySlashed',
);
```
A stake can be slashed only once per evaluation. This is idempotency protection — calling `slash_non_revealer` twice on the same stake reverts the second time.

### 4. Load stake + compute slash amount
```cairo
let stake = self.stakes.entry(stake_id).read();
let owner = stake.owner;
let bps: u256 = self.non_reveal_slash_bps.read().try_into().unwrap_or(0);
let slash_amount = stake.amount * bps / BPS_DENOM;
```
- Reads the stake record to get its amount and owner.
- Reads the configured non-reveal slash rate (e.g., 3000 bps = 30%).
- Computes `slash_amount = stake.amount × bps / 10,000`. Integer division truncates.

### 5. Apply the slash (conditional on nonzero amount)
```cairo
if slash_amount > 0 {
    self._apply_stake_slash(stake_id, slash_amount);

    let mut dm = self.evaluations.entry(evaluation_id).read();
    dm.slash_pool += slash_amount;
    self.evaluations.entry(evaluation_id).write(dm);

    self.stake_slashed_total.entry((stake_id, evaluation_id)).write(slash_amount);
}
```
Three things happen inside this block:
1. **`_apply_stake_slash`** reduces the stake's `amount` by `slash_amount` in storage (the juror's escrowed tokens are burned/reduced).
2. The evaluation's `slash_pool` is incremented by the same amount — these slashed tokens accumulate in the evaluation's slash pool (used later for coherent-juror rewards during finalization).
3. `stake_slashed_total[(stake_id, evaluation_id)]` records how much this specific stake was slashed in this evaluation (used for accounting/views and for capping multi-dispute slashing).

If `slash_amount == 0` (e.g., slash rate is 0 or stake amount is tiny), none of this state is mutated.

### 6. Mark as slashed
```cairo
self.evaluation_slashed.entry((evaluation_id, stake_id)).write(true);
```
Sets the `evaluation_slashed` flag so subsequent calls to `slash_non_revealer` on this same stake revert with `AlreadySlashed`.

### 7. Emit slash event
```cairo
self.emit(JurorSlashed { evaluation_id, jural: owner, amount: slash_amount });
```
Emits `JurorSlashed` (indexed by evaluation, juror/owner) so off-chain indexers and frontends can detect slashing events.

### 8. Slash keeper reward (optional caller incentive)
```cairo
let caller = get_caller_address();
if caller != owner
    && SLASH_KEEPER_REWARD > 0
    && self._token().mint_from_budget(caller, SLASH_KEEPER_REWARD) {
    self.emit(SlashKeeperRewarded { caller, juror: owner, evaluation_id, reward: SLASH_KEEPER_REWARD });
}
```
This is the "bounty hunter" mechanic:
- **`caller != owner`**: A juror cannot claim the reward for slashing themselves.
- **`SLASH_KEEPER_REWARD > 0`**: The reward is configurable (constant, default `500 * 10^15` wei = 0.5 tokens). Can be set to 0 to disable.
- **`_token().mint_from_budget`**: Attempts to mint the reward from ConvictionToken's monthly budget. It's best-effort — if the budget is exhausted, the mint returns `false` and no reward event is emitted, but the slash itself still stands.
- If successful, emits `SlashKeeperRewarded`.

**Note on the `_token()` call:** This is a cross-contract call into ConvictionToken. Since `reentrancyguard` is still active and `_token().mint_from_budget` checks `_assert_module()` (caller must be Selection or Governance), this is safe — the call originates from Selection itself.

### 9. Exit
```cairo
self.reentrancyguard.end();
```
Releases the reentrancy lock.

---

## Summary table

| Step | Action | Storage touched |
|------|--------|-----------------|
| Guard | Reentrancy lock + read evaluation | `evaluations` (read) |
| Deadline | Assert reveal window closed | — |
| Validation | Drawn? Not revealed? Not already slashed? | `_is_stake_drawn` (reads), `evaluation_revealed` (read), `evaluation_slashed` (read) |
| Compute | Read stake + param; compute `amount × bps / 10,000` | `stakes` (read), `non_reveal_slash_bps` (read) |
| Slash | Reduce stake, add to slash pool, record per-stake total | `stakes` (write), `evaluations` (write), `stake_slashed_total` (write) |
| Mark | Set `evaluation_slashed = true` | `evaluation_slashed` (write) |
| Event | Emit `JurorSlashed` | — |
| Reward | Best-effort mint from budget to caller | ConvictionToken storage (external), `budget_reward_minted` etc. |
| Event | Emit `SlashKeeperRewarded` (if minted) | — |
| Exit | Release guard | — |

---

## Security & design notes

- **Permissionless**: Anyone can call this — no admin check. This is intentional so the protocol doesn't rely on a specific actor to punish non-revealers.
- **Reveal deadline enforced**: You can't slash before the reveal window ends, preventing premature slashing.
- **Idempotent**: `AlreadySlashed` prevents double-counting if multiple callers race to slash the same juror.
- **Keeper reward is best-effort**: If the monthly budget is empty, the slash still happens but no reward is paid. This prevents the whole slash from reverting due to budget constraints.
- **No reentrancy risk from `_token()`**: The call goes out while the guard is held, but ConvictionToken's `mint_from_budget` checks `_assert_module()` (only Selection/Governance can call), so a malicious token contract can't re-enter Selection in a harmful way here.
