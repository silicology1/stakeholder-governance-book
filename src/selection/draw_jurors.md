# Draw jurors


```cairo
fn draw_jurors(ref self: ContractState, evaluation_id: u256) {
            self.reentrancyguard.start();
            let mut e = self.evaluations.entry(evaluation_id).read();
            assert(e.phase == PHASE_DRAWING, 'NotDrawingPhase');

            let min_jurors = self.min_jurors_per_evaluation.read();

            let vrf_seed: felt252 = self
                .vrf_consumer
                .consume_random(Source::Nonce(get_contract_address()));
            let block_hash = self._recent_block_hash();

            let mut seed_input: Array<felt252> = ArrayTrait::new();
            seed_input.append(vrf_seed);
            seed_input.append(block_hash);
            let base_seed: felt252 = poseidon_hash_span(seed_input.span());

            let mut drawn: u32 = e.drawn_count;
            let mut draw_idx: u32 = self.evaluation_draw_index.entry(evaluation_id).read();

            loop {
                if drawn >= min_jurors {
                    break;
                }

                let total_weight = self._fenwick_total_eval(evaluation_id);
                if total_weight == 0 {
                    break;
                }

                let rand_felt = derive_draw_random(base_seed, evaluation_id, draw_idx);
                let rand_u256: u256 = rand_felt.try_into().unwrap_or(0);
                let target = rand_u256 % total_weight;

                let index = self._fenwick_find_eval(evaluation_id, target);
                let stake_id = self
                    .evaluation_index_to_stake
                    .entry((evaluation_id, index))
                    .read();

                if stake_id == 0 {
                    draw_idx += 1;
                    continue;
                }

                let stake = self.stakes.entry(stake_id).read();
                let owner = stake.owner;

                self._fenwick_sub_eval(evaluation_id, index, stake.amount);
                self.evaluation_stake_to_index
                    .entry((evaluation_id, stake_id))
                    .write(0);
                self.evaluation_index_to_stake
                    .entry((evaluation_id, index))
                    .write(0);

                self.evaluation_drawn_stakes.entry((evaluation_id, drawn)).write(stake_id);
                drawn += 1;

                self.emit(JurorDrawn {
                    evaluation_id,
                    stake_id,
                    juror: owner,
                    draw_index: draw_idx,
                });
                draw_idx += 1;
            };

            e.drawn_count = drawn;
            self.evaluations.entry(evaluation_id).write(e);
            self.evaluation_draw_index.entry(evaluation_id).write(draw_idx);

            if drawn >= min_jurors {
                e.phase = PHASE_COMMIT;
                let now = get_block_timestamp();
                e.commit_deadline = now + self.commit_duration.read();
                self.evaluations.entry(evaluation_id).write(e);
                self.emit(EvaluationAdvanced { evaluation_id, phase: PHASE_COMMIT });
            }

            self.reentrancyguard.end();
        }
```




### 1. Entry: reentrancy lock + evaluation state
```cairo
self.reentrancyguard.start();
let mut e = self.evaluations.entry(evaluation_id).read();
assert(e.phase == PHASE_DRAWING, 'NotDrawingPhase');
```
Starts the reentrancy guard (this function mutates storage and emits events). Loads the evaluation record. The function only proceeds if the evaluation is in `PHASE_DRAWING` — otherwise it reverts with `NotDrawingPhase`.

### 2. Read the minimum jurors parameter
```cairo
let min_jurors = self.min_jurors_per_evaluation.read();
```
This is the threshold: drawing continues until `drawn_count >= min_jurors`.

### 3. Derive the base random seed
```cairo
let vrf_seed: felt252 = self
    .vrf_consumer
    .consume_random(Source::Nonce(get_contract_address()));
let block_hash = self._recent_block_hash();

let mut seed_input: Array<felt252> = ArrayTrait::new();
seed_input.append(vrf_seed);
seed_input.append(block_hash);
let base_seed: felt252 = poseidon_hash_span(seed_input.span());
```
- **`consume_random`**: calls the Cartridge VRF consumer component to get one verified random felt from the VRF provider. Uses `Source::Nonce(get_contract_address())` as the request identifier.
- **`_recent_block_hash`**: reads a syscall-available block hash (10 blocks back) as an on-chain entropy component that can't be withheld by off-chain parties.
- **Poseidon hash**: combines the VRF seed + block hash into a single `base_seed` felt252. This is the entropy source for all draws in this evaluation.

### 4. Initialize draw counters
```cairo
let mut drawn: u32 = e.drawn_count;
let mut draw_idx: u32 = self.evaluation_draw_index.entry(evaluation_id).read();
```
- `drawn`: how many jurors have been drawn so far (resumes from where a previous call left off).
- `draw_idx`: the draw index counter (used to vary the randomness per draw attempt). Also resumed from storage.

### 5. The draw loop
```cairo
loop {
    if drawn >= min_jurors {
        break;
    }
```
Exit once we've drawn enough jurors.

```cairo
    let total_weight = self._fenwick_total_eval(evaluation_id);
    if total_weight == 0 {
        break;
    }
```
Reads the total staked weight currently in the Fenwick tree for this evaluation. If nothing is left to draw from (all stakes already drawn or removed), exit early.

```cairo
    let rand_felt = derive_draw_random(base_seed, evaluation_id, draw_idx);
    let rand_u256: u256 = rand_felt.try_into().unwrap_or(0);
    let target = rand_u256 % total_weight;
```
- **`derive_draw_random`**: hashes `(base_seed, evaluation_id, draw_idx)` with Poseidon to get a unique felt for this specific draw attempt. Incrementing `draw_idx` prevents reusing the same randomness.
- **Modulo**: maps the random value into the range `[0, total_weight)`, giving a target position in the weighted distribution.

```cairo
    let index = self._fenwick_find_eval(evaluation_id, target);
    let stake_id = self.evaluation_index_to_stake.entry((evaluation_id, index)).read();
```
- **`_fenwick_find_eval`**: walks the Fenwick tree to find which stake index owns the `target` weight position — this is the weighted selection step (stakes with more weight are more likely to be selected).
- Looks up the stake ID at that Fenwick index.

```cairo
    if stake_id == 0 {
        draw_idx += 1;
        continue;
    }
```
If the index is empty (stake was already drawn or removed in a prior call), skip it and try the next draw index. The loop continues without incrementing `drawn`.

```cairo
    let stake = self.stakes.entry(stake_id).read();
    let owner = stake.owner;

    self._fenwick_sub_eval(evaluation_id, index, stake.amount);
    self.evaluation_stake_to_index.entry((evaluation_id, stake_id)).write(0);
    self.evaluation_index_to_stake.entry((evaluation_id, index)).write(0);
```
- Reads the stake record to get its amount and owner.
- **`_fenwick_sub_eval`**: subtracts the stake's weight from the Fenwick tree so it can't be drawn again.
- Clears both index mappings (`stake_id → index` and `index → stake_id`) by writing 0.

```cairo
    self.evaluation_drawn_stakes.entry((evaluation_id, drawn)).write(stake_id);
    drawn += 1;

    self.emit(JurorDrawn { evaluation_id, stake_id, juror: owner, draw_index: draw_idx });
    draw_idx += 1;
```
- Records the drawn stake ID in the drawn-stakes array at position `drawn`.
- Increments the drawn counter.
- Emits `JurorDrawn` (indexed by evaluation, stake, and juror owner).
- Increments the draw index for the next iteration.

### 6. Persist draw state
```cairo
e.drawn_count = drawn;
self.evaluations.entry(evaluation_id).write(e);
self.evaluation_draw_index.entry(evaluation_id).write(draw_idx);
```
Writes the updated `drawn_count` and `draw_idx` back to storage so a subsequent call can resume.

### 7. Phase transition to COMMIT
```cairo
if drawn >= min_jurors {
    e.phase = PHASE_COMMIT;
    let now = get_block_timestamp();
    e.commit_deadline = now + self.commit_duration.read();
    self.evaluations.entry(evaluation_id).write(e);
    self.emit(EvaluationAdvanced { evaluation_id, phase: PHASE_COMMIT });
}
```
If enough jurors were drawn, the evaluation advances to `PHASE_COMMIT`, the commit deadline is set (`now + commit_duration`), the state is persisted, and `EvaluationAdvanced` is emitted. If `min_jurors` was not met (e.g., total weight ran out), the phase stays in DRAWING — the evaluation will eventually be dismissed by `advance_evaluation`.

### 8. Exit
```cairo
self.reentrancyguard.end();
```

---

### Key properties

| Property | Detail |
|----------|--------|
| **Weighted selection** | Uses Fenwick tree prefix sums so probability of selection is proportional to stake amount |
| **Deterministic randomness** | VRF proof + block hash + draw index are combined via Poseidon; no single party controls the outcome |
| **Resumable** | `drawn` and `draw_idx` are stored, so the loop can continue across multiple calls if it runs out of gas |
| **No duplicate draws** | `_fenwick_sub_eval` removes weight immediately, and empty indices are skipped |
| **Auto-advances to COMMIT** | Once `min_jurors` are drawn, phase flips to COMMIT and the commit window opens |
| **Gas cost** | Each iteration does several storage reads/writes plus a Fenwick tree walk (O(log size)); drawing 100 jurors costs ~28M L2 gas at max |
