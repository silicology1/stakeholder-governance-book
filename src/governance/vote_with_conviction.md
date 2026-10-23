```cairo
fn vote_with_conviction(
            ref self: ContractState, proposal_id: u256, conviction_id: u32, score: i8,
        ) {
            self.reentrancyguard.start();
            assert(score >= -5 && score <= 5, 'InvalidScore');

            let count = self.proposal_count.read();
            assert(proposal_id < count, 'InvalidProposalId');

            let p = self.proposals.entry(proposal_id).read();
            assert(!p.executed, 'AlreadyExecuted');
            assert(!p.final_score_set, 'AlreadyFinalized');

            let caller = get_caller_address();
            assert(p.author != caller, 'SelfVotingNotAllowed');
            let mut c = self.convictions.entry((caller, conviction_id)).read();
            assert(c.owner == caller, 'Unauthorized');
            assert(!c.released, 'ConvictionReleased');
            let already = self
                .conviction_voted_on
                .entry((caller, conviction_id, proposal_id))
                .read();
            assert(!already, 'AlreadyVotedOnProposal');
            let lock_expiry = c.created_at + c.lock_duration;
            assert(get_block_timestamp() < lock_expiry, 'LockExpired');
            assert(c.votes_cast < self.max_votes_per_conviction.read(), 'MaxVotesReached');

            let weight = self._vote_weight(@c);

            let bucket: u8 = (score + 5).try_into().unwrap();
            let cur = self.proposal_score_counts.entry((proposal_id, bucket)).read();
            self.proposal_score_counts.entry((proposal_id, bucket)).write(cur + weight);

            let mut pm = self.proposals.entry(proposal_id).read();
            pm.power_total += weight;
            self.proposals.entry(proposal_id).write(pm);

            c.votes_cast += 1;
            self.convictions.entry((caller, conviction_id)).write(c);
            self.conviction_voted_on.entry((caller, conviction_id, proposal_id)).write(true);

            self.emit(SupportAdded { proposal_id, owner: caller, conviction_id });
            self.reentrancyguard.end();
        }
```
### 1. Entry: reentrancy lock + score validation
```cairo
self.reentrancyguard.start();
assert(score >= -5 && score <= 5, 'InvalidScore');
```
- Locks against reentrancy (this function mutates proposal state and conviction state).
- Validates the score is in the inclusive range -5 through 5.

---

### 2. Proposal existence and state checks
```cairo
let count = self.proposal_count.read();
assert(proposal_id < count, 'InvalidProposalId');

let p = self.proposals.entry(proposal_id).read();
assert(!p.executed, 'AlreadyExecuted');
assert(!p.final_score_set, 'AlreadyFinalized');
```
- The proposal must exist.
- It must not have been executed yet (voting closes after execution).
- It must not have a final score set (voting closes after finalization).

---

### 3. Caller authorization
```cairo
let caller = get_caller_address();
assert(p.author != caller, 'SelfVotingNotAllowed');
```
The proposal author cannot vote on their own proposal — prevents self-dealing where the author inflates their own proposal's score.

---

### 4. Conviction ownership and status
```cairo
let mut c = self.convictions.entry((caller, conviction_id)).read();
assert(c.owner == caller, 'Unauthorized');
assert(!c.released, 'ConvictionReleased');
```
- The conviction must belong to the caller.
- It must not have been released (released convictions can still have their historical power counted, but new votes are blocked — actually, let me check... `released` blocks new votes here).

---

### 5. Double-vote prevention
```cairo
let already = self.conviction_voted_on.entry((caller, conviction_id, proposal_id)).read();
assert(!already, 'AlreadyVotedOnProposal');
```
A specific conviction can vote on a specific proposal only once. This is keyed by `(owner, conviction_id, proposal_id)`.

---

### 6. Lock expiry check
```cairo
let lock_expiry = c.created_at + c.lock_duration;
assert(get_block_timestamp() < lock_expiry, 'LockExpired');
```
The conviction's stake must still be locked. `lock_duration = level × conviction_base_lock` was set at creation. Once the lock expires, the conviction can no longer cast new votes (though previously cast votes remain counted).

---

### 7. Vote limit per conviction
```cairo
assert(c.votes_cast < self.max_votes_per_conviction.read(), 'MaxVotesReached');
```
A conviction can vote on at most `max_votes_per_conviction` distinct proposals (default 10, configurable up to 1000). This prevents one conviction from dominating every proposal.

---

### 8. Compute voting weight
```cairo
let weight = self._vote_weight(@c);
```
Vote weight = `isqrt(level × amount)`. Higher level and higher amount both increase power, but with diminishing returns (square root).

---

### 9. Record the vote in score bucket
```cairo
let bucket: u8 = (score + 5).try_into().unwrap();
let cur = self.proposal_score_counts.entry((proposal_id, bucket)).read();
self.proposal_score_counts.entry((proposal_id, bucket)).write(cur + weight);
```
- Maps score -5..5 to bucket 0..10.
- Adds `weight` to that bucket's accumulator. This is how the weighted score distribution is tracked without storing individual votes.

---

### 10. Update proposal's frozen power total
```cairo
let mut pm = self.proposals.entry(proposal_id).read();
pm.power_total += weight;
self.proposals.entry(proposal_id).write(pm);
```
`power_total` is the frozen sum of all vote weights cast on this proposal. It's read O(1) during `execute_proposal` to determine if the threshold is met.

---

### 11. Update conviction state
```cairo
c.votes_cast += 1;
self.convictions.entry((caller, conviction_id)).write(c);
self.conviction_voted_on.entry((caller, conviction_id, proposal_id)).write(true);
```
- Increments the conviction's vote count.
- Marks this conviction-proposal pair as voted.

---

### 12. Emit event
```cairo
self.emit(SupportAdded { proposal_id, owner: caller, conviction_id });
```
Indexed by proposal and owner for off-chain tracking.

---

### 13. Exit
```cairo
self.reentrancyguard.end();
```

---

## Security properties

| Property | Enforcement |
|----------|-------------|
| No reentrancy | `reentrancyguard` around state mutations |
| Valid score | -5 ≤ score ≤ 5 |
| Proposal exists & open | `proposal_id < count`, `!executed`, `!final_score_set` |
| No self-voting | `p.author != caller` |
| Conviction ownership | `c.owner == caller` |
| No released convictions | `!c.released` |
| No double vote | `conviction_voted_on[(caller, conviction_id, proposal_id)]` |
| Lock not expired | `now < created_at + lock_duration` |
| Vote limit | `votes_cast < max_votes_per_conviction` |

## Key design note: O(1) voting

The proposal's `power_total` is updated incrementally at vote time (`pm.power_total += weight`). This means `execute_proposal` doesn't need to iterate over all supporters — it reads the frozen accumulator directly. Combined with no per-proposal supporter registry, this enables unbounded voting with O(1) execution.
