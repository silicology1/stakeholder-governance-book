```cairo
fn create_proposal(
            ref self: ContractState, funding_wallet: ContractAddress, evidence: ByteArray,
        ) -> u256 {
            self.reentrancyguard.start();
            let caller = get_caller_address();
            assert(funding_wallet.is_non_zero(), 'ZeroAddress');
            assert(evidence.len() > 0, 'EvidenceRequired');
            assert(evidence.len() <= MAX_EVIDENCE_LEN, 'EvidenceTooLong');

            let deposit = self.reputation_stake.read();
            self._token().escrow(caller, deposit);

            let proposal_id = self.proposal_count.read();
            self.proposal_count.write(proposal_id + 1);

            let p = FundingProposal {
                author: caller,
                funding_wallet,
                evidence,
                created_at: get_block_timestamp(),
                executed: false,
                power_total: 0,
                deposit_amount: deposit,
                final_score: 0,
                final_score_set: false,
            };
            self.proposals.entry(proposal_id).write(p);

            self.emit(ProposalCreated { proposal_id, author: caller, deposit_amount: deposit });
            self.reentrancyguard.end();
            proposal_id
        }
```


### 1. Entry: reentrancy lock + caller
```cairo
self.reentrancyguard.start();
let caller = get_caller_address();
```
Acquires the reentrancy guard (this function makes an external call into ConvictionToken via `_token().escrow`, so protection matters). Captures the caller as the proposal author.

---

### 2. Input validation
```cairo
assert(funding_wallet.is_non_zero(), 'ZeroAddress');
assert(evidence.len() > 0, 'EvidenceRequired');
assert(evidence.len() <= MAX_EVIDENCE_LEN, 'EvidenceTooLong');
```
Three guards:
- `funding_wallet` must not be the zero address (can't send rewards to nowhere)
- Evidence must be non-empty (a proposal must include something)
- Evidence must be at most `MAX_EVIDENCE_LEN` bytes (1,024) — prevents calldata/gas griefing

---

### 3. Escrow the reputation deposit
```cairo
let deposit = self.reputation_stake.read();
self._token().escrow(caller, deposit);
```
Reads the configured reputation deposit and moves that amount of ERC20 from the caller into the ConvictionToken contract's custody. `self._token()` returns an `IConvictionTokenDispatcher` pointing at the token module; `escrow` is module-gated (only `Selection` and `Governance` can call it), and Governance is authorized.

---

### 4. Allocate proposal ID
```cairo
let proposal_id = self.proposal_count.read();
self.proposal_count.write(proposal_id + 1);
```
Atomically reads and increments the proposal counter. Each proposal gets a unique, sequential ID starting from 0.

---

### 5. Create and store the proposal record
```cairo
let p = FundingProposal {
    author: caller,
    funding_wallet,
    evidence,
    created_at: get_block_timestamp(),
    executed: false,
    power_total: 0,
    deposit_amount: deposit,
    final_score: 0,
    final_score_set: false,
};
self.proposals.entry(proposal_id).write(p);
```

| Field | Value | Meaning |
|-------|-------|---------|
| `author` | `caller` | Who created it |
| `funding_wallet` | caller-provided | Where rewards go if score > 0 |
| `evidence` | caller-provided | Justification/IPFS hash/etc. |
| `created_at` | `get_block_timestamp()` | Creation timestamp (used for voting-period check) |
| `executed` | `false` | Not yet executed |
| `power_total` | `0` | Frozen accumulator of conviction votes (bumped at vote time) |
| `deposit_amount` | `deposit` | The escrowed reputation stake |
| `final_score` | `0` | Not yet determined |
| `final_score_set` | `false` | Score not yet computed |

---

### 6. Emit event
```cairo
self.emit(ProposalCreated { proposal_id, author: caller, deposit_amount: deposit });
```
Emits an indexed event so off-chain indexers and frontends can track new proposals.

---

### 7. Exit
```cairo
self.reentrancyguard.end();
proposal_id
```
Releases the reentrancy lock and returns the new proposal ID to the caller.

---

## Security properties

| Property | How it's enforced |
|----------|-------------------|
| No reentrancy | `reentrancyguard` around the external `_token().escrow` call |
| Valid funding target | `funding_wallet.is_non_zero()` |
| Evidence present & sized | `EvidenceRequired` / `EvidenceTooLong` |
| Deposit escrowed | `escrow` moves tokens into contract custody before the proposal record exists |
| Proposal IDs unique | `proposal_count` incremented atomically |
| Module-gated custody | Only `Selection` and `Governance` can call `escrow` on ConvictionToken |

---

## Note on ordering

The deposit is escrowed **before** the proposal record is written. If `escrow` reverts (e.g., insufficient balance), no proposal is created and no state changes persist — the `reentrancyguard` ensures atomicity on failure.
