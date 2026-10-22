```cairo
fn commit_vote(
            ref self: ContractState, evaluation_id: u256, stake_id: u256, commit_hash: felt252,
        ) {
            self.reentrancyguard.start();
            let caller = get_caller_address();
            let e = self.evaluations.entry(evaluation_id).read();
            assert(e.phase == PHASE_COMMIT, 'NotCommitPhase');
            assert(get_block_timestamp() < e.commit_deadline, 'CommitClosed');

            let stake = self.stakes.entry(stake_id).read();
            assert(stake.owner == caller, 'NotStakeOwner');
            assert(self._is_stake_drawn(evaluation_id, stake_id), 'NotDrawnStake');
            assert(
                !self.evaluation_committed.entry((evaluation_id, stake_id)).read(),
                'AlreadyCommitted',
            );

            self.evaluation_commit.entry((evaluation_id, stake_id)).write(commit_hash);
            self.evaluation_committed.entry((evaluation_id, stake_id)).write(true);

            self.emit(VoteCommitted { evaluation_id, juror: caller });
            self.reentrancyguard.end();
        }

         fn reveal_vote(
             ref self: ContractState, evaluation_id: u256, stake_id: u256, score: i8, salt: felt252,
         ) {
             self.reentrancyguard.start();
             let caller = get_caller_address();
             let mut e = self.evaluations.entry(evaluation_id).read();
             assert(get_block_timestamp() >= e.commit_deadline, 'CommitStillOpen');
             assert(get_block_timestamp() < e.reveal_deadline, 'RevealClosed');
             assert(score >= -5 && score <= 5, 'InvalidScore');
 
             let stake = self.stakes.entry(stake_id).read();
             assert(stake.owner == caller, 'NotStakeOwner');
             assert(self._is_stake_drawn(evaluation_id, stake_id), 'NotDrawnStake');
             assert(self.evaluation_committed.entry((evaluation_id, stake_id)).read(), 'NoCommit');
             assert(
                 !self.evaluation_revealed.entry((evaluation_id, stake_id)).read(),
                 'AlreadyRevealed',
             );
 
             let mut hash_input: Array<felt252> = ArrayTrait::new();
             hash_input.append(score.try_into().unwrap_or(0));
             hash_input.append(salt);
             let computed = poseidon_hash_span(hash_input.span());
             let stored = self.evaluation_commit.entry((evaluation_id, stake_id)).read();
             assert(computed == stored, 'HashMismatch');
 
             self.evaluation_score.entry((evaluation_id, stake_id)).write(score);
             self.evaluation_revealed.entry((evaluation_id, stake_id)).write(true);
 
             self.emit(VoteRevealed { evaluation_id, juror: caller, score });
             self.reentrancyguard.end();
         }
```


## `commit_vote` — line by line

### Entry & guard
```cairo
self.reentrancyguard.start();
```
Locks the contract against reentrant calls during this external invocation.

```cairo
let caller = get_caller_address();
```
Captures who is calling. This is the juror address that must own the stake being used.

### Read evaluation & phase gate
```cairo
let e = self.evaluations.entry(evaluation_id).read();
assert(e.phase == PHASE_COMMIT, 'NotCommitPhase');
```
Loads the evaluation record. Commits are only accepted during the **commit phase**. If the evaluation is still in DRAWING or already in REVEAL/FINALIZED, this reverts.

```cairo
assert(get_block_timestamp() < e.commit_deadline, 'CommitClosed');
```
Ensures the commit window hasn't closed yet. After `commit_deadline`, no new commitments are accepted.

### Stake validation
```cairo
let stake = self.stakes.entry(stake_id).read();
assert(stake.owner == caller, 'NotStakeOwner');
```
Only the stake's owner can submit a commitment for it. Prevents one juror from voting on another's behalf.

```cairo
assert(self._is_stake_drawn(evaluation_id, stake_id), 'NotDrawnStake');
```
Only jurors who were actually drawn in the drawing phase can commit. Undrawn stakes are rejected.

```cairo
assert(
    !self.evaluation_committed.entry((evaluation_id, stake_id)).read(),
    'AlreadyCommitted',
);
```
A stake can commit exactly once. Double-committing is blocked.

### Store the commitment
```cairo
self.evaluation_commit.entry((evaluation_id, stake_id)).write(commit_hash);
self.evaluation_committed.entry((evaluation_id, stake_id)).write(true);
```
Two storage writes:
1. The Poseidon hash of `(score, salt)` is stored under `(evaluation_id, stake_id)`.
2. A boolean flag marks this stake as having committed.

### Emit event & release guard
```cairo
self.emit(VoteCommitted { evaluation_id, juror: caller });
self.reentrancyguard.end();
```
Emits an indexed event so off-chain indexers can track participation, then releases the reentrancy lock.

---

## `reveal_vote` — line by line

### Entry & guard
```cairo
self.reentrancyguard.start();
let caller = get_caller_address();
let mut e = self.evaluations.entry(evaluation_id).read();
```
Same pattern: lock, capture caller, load evaluation (mutable because the phase may change below).

### Deadline gates
```cairo
assert(get_block_timestamp() >= e.commit_deadline, 'CommitStillOpen');
```
Revealing is not allowed until after the commit deadline has passed. This ensures everyone commits before anyone reveals.

```cairo
assert(get_block_timestamp() < e.reveal_deadline, 'RevealClosed');
```
Revealing must happen before the reveal deadline. Late reveals are rejected.

### Score validation
```cairo
assert(score >= -5 && score <= 5, 'InvalidScore');
```
Scores are bounded to [-5, 5], matching the protocol's scoring range.


### Stake validation (same as commit)
```cairo
let stake = self.stakes.entry(stake_id).read();
assert(stake.owner == caller, 'NotStakeOwner');
assert(self._is_stake_drawn(evaluation_id, stake_id), 'NotDrawnStake');
```
Same owner and drawn-stake checks as `commit_vote`.

### Commit existence & uniqueness checks
```cairo
assert(self.evaluation_committed.entry((evaluation_id, stake_id)).read(), 'NoCommit');
```
You cannot reveal without having committed first. The commitment hash must exist.

```cairo
assert(
    !self.evaluation_revealed.entry((evaluation_id, stake_id)).read(),
    'AlreadyRevealed',
);
```
A stake can reveal exactly once.

### Hash verification — the core of commit/reveal
```cairo
let mut hash_input: Array<felt252> = ArrayTrait::new();
hash_input.append(score.try_into().unwrap_or(0));
hash_input.append(salt);
let computed = poseidon_hash_span(hash_input.span());
let stored = self.evaluation_commit.entry((evaluation_id, stake_id)).read();
assert(computed == stored, 'HashMismatch');
```
This is the cryptographic binding:
1. The caller provides `score` and `salt`.
2. The contract hashes `(score, salt)` with Poseidon.
3. It compares against the hash stored during `commit_vote`.

If they don't match, the reveal is rejected. This prevents a juror from changing their vote after seeing others' commitments (the commitment is binding).

### Store the revealed vote
```cairo
self.evaluation_score.entry((evaluation_id, stake_id)).write(score);
self.evaluation_revealed.entry((evaluation_id, stake_id)).write(true);
```
Two storage writes:
1. The actual score (e.g., `5`, `-2`, `0`) is stored.
2. A boolean flag marks this stake as having revealed.

### Emit event & release guard
```cairo
self.emit(VoteRevealed { evaluation_id, juror: caller, score });
self.reentrancyguard.end();
```
Emits an indexed event with the score (public after reveal), then releases the lock.

---

## Summary of the commit/reveal lifecycle for one stake

| Step | Function | Storage written | When allowed |
|------|----------|----------------|--------------|
| 1 | `commit_vote` | `evaluation_commit[(eval, stake)] = hash` | During commit phase, before `commit_deadline` |
| 2 | `reveal_vote` | `evaluation_score[(eval, stake)] = score` | After `commit_deadline`, before `reveal_deadline` |

**Key security properties:**
- **Binding**: The juror cannot change their score after committing, because the hash commits to `(score, salt)`.
- **Hiding**: During the commit phase, no one knows anyone else's score — only hashes are visible.
- **Non-repudiation**: Only the stake owner can commit/reveal, and only if drawn.
- **Single use**: A stake commits and reveals at most once per evaluation.

**One subtlety:** If all drawn jurors commit but none reveal before `reveal_deadline`, `finalize_evaluation` handles it as "zero reveals" and settles score-neutral (`final_score = 0`).
