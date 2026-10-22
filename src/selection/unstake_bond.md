```cairo
fn unstake_bond(ref self: ContractState, evaluation_id: u256) {
            self.reentrancyguard.start();
            let caller = get_caller_address();
            let mut e = self.evaluations.entry(evaluation_id).read();
            assert(e.final_score_set, 'NotFinalized');
            assert(e.requester == caller, 'NotRequester');
            assert(!e.bond_settled, 'BondAlreadySettled');
            assert(e.final_score >= 0, 'NegativeScore');

            let bond_amount = e.bond_amount;
            e.bond_settled = true;
            self.evaluations.entry(evaluation_id).write(e);

            if bond_amount > 0 {
                self._token().release(caller, bond_amount);
                self.emit(BondRefunded { evaluation_id, requester: caller, amount: bond_amount });
            }

            self.reentrancyguard.end();
        }
```

### 1. Entry: reentrancy lock + caller
```cairo
self.reentrancyguard.start();
let caller = get_caller_address();
```
Acquires the reentrancy guard and captures the caller address. The caller must be the bond requester (checked below).

---

### 2. Load evaluation + authorization gates
```cairo
let mut e = self.evaluations.entry(evaluation_id).read();
assert(e.final_score_set, 'NotFinalized');
assert(e.requester == caller, 'NotRequester');
assert(!e.bond_settled, 'BondAlreadySettled');
assert(e.final_score >= 0, 'NegativeScore');
```

Four checks in order:
- **`NotFinalized`**: The evaluation must be finalized first. Bond settlement happens only after a final score exists.
- **`NotRequester`**: Only the evaluation requester (the candidate who paid the bond) can unstake it. Other jurors/admins cannot.
- **`BondAlreadySettled`**: The bond can be settled exactly once — either refunded or slashed. Prevents double withdrawal.
- **`NegativeScore`**: If the final score is negative, the bond was already slashed into the evaluation's slash pool during `finalize_evaluation`. There is nothing to refund here.

---

### 3. Capture bond amount + mark settled
```cairo
let bond_amount = e.bond_amount;
e.bond_settled = true;
self.evaluations.entry(evaluation_id).write(e);
```
- Saves `bond_amount` into a local before mutating `e`.
- Sets `bond_settled = true` so no one (including this caller) can call this function again.
- Persists the updated evaluation to storage immediately, before the external token call. This prevents reentrancy issues where the caller might try to re-enter and claim the bond again.

---

### 4. Refund the bond
```cairo
if bond_amount > 0 {
    self._token().release(caller, bond_amount);
    self.emit(BondRefunded { evaluation_id, requester: caller, amount: bond_amount });
}
```
- Cross-contract call to ConvictionToken's `_transfer(from=contract, to=caller, amount=bond_amount)`. This moves the escrowed bond back to the requester's wallet.
- Emits `BondRefunded` (indexed by evaluation and requester) so off-chain indexers can track the refund.
- If `bond_amount == 0` (zero bond edge case), no transfer and no event — the settlement flag is already set, so the evaluation is still marked as closed.

---

### 5. Exit
```cairo
self.reentrancyguard.end();
```
Releases the lock.

---

## Summary table

| Step | Action | Revert condition |
|------|--------|-----------------|
| Guard | `reentrancyguard.start()` | — |
| Load eval | Read `evaluations[evaluation_id]` | — |
| Finalized check | `e.final_score_set` | `NotFinalized` |
| Requester check | `e.requester == caller` | `NotRequester` |
| Not settled | `!e.bond_settled` | `BondAlreadySettled` |
| Non-negative score | `e.final_score >= 0` | `NegativeScore` |
| Mark settled | `e.bond_settled = true`, write to storage | — |
| Transfer | `_token().release(caller, bond_amount)` | — |
| Event | `BondRefunded` | — |
| Guard end | `reentrancyguard.end()` | — |

---

## Key design notes

- **Bond settlement is final**: Once `bond_settled = true`, the evaluation record is immutable with respect to the bond. The requester cannot call this again, and `finalize_evaluation` also respects `bond_settled` (it won't double-refund or double-slash).
- **Negative scores slash automatically**: In `finalize_evaluation`, when `final_score < 0`, the bond is added to `e.slash_pool` and `bond_settled` is set to `true`. So `unstake_bond` reverts with `NegativeScore` — there's nothing left to refund.
- **Cross-contract custody**: The bond lives in ConvictionToken's custody (escrowed during `request_evaluation`). `unstake_bond` calls `_token().release`, which is module-gated — only Selection can trigger it.
- **Reentrancy safety**: The storage write (`bond_settled = true`) happens *before* the external `_token().release` call, following the checks-effects-interactions pattern.
