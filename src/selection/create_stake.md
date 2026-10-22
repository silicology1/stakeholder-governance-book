

```cairo
fn create_stake(ref self: ContractState, amount: u256) -> u256 {
    self.reentrancyguard.start();
    assert(amount > 0, 'ZeroAmount');
    let caller = get_caller_address();

    self._token().escrow(caller, amount);

    let stake_id = self.stake_count.read();
    self.stake_count.write(stake_id + 1);

    let stake = Stake {
        owner: caller,
        amount,
        created_at: get_block_timestamp(),
    };
    self.stakes.entry(stake_id).write(stake);

    let stake_count = self.juror_stake_count.entry(caller).read();
    self.juror_stake_ids.entry((caller, stake_count)).write(stake_id);
    self.juror_stake_count.entry(caller).write(stake_count + 1);

    self.emit(StakeCreated { stake_id, owner: caller, amount });

    self.reentrancyguard.end();
    stake_id
}
```


Elaborate code: 
```cairo
self._token().escrow(caller, amount);
```

selection.cairo

```cairo
  #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _token(self: @ContractState) -> IConvictionTokenDispatcher {
            IConvictionTokenDispatcher { contract_address: self.token.read() }
        }
```

interfaces/iconviction_token.cairo

```cairo
#[starknet::interface]
pub trait IConvictionToken<TContractState> {
/// Burns `amount` of the caller's ERC20 and records it for recycling.
fn burn(ref self: TContractState, amount: u256);

// ---- module-gated custody ----

/// Moves `amount` from `from` into contract custody on behalf of an
/// authorized module.
fn escrow(ref self: TContractState, from: ContractAddress, amount: u256);
```

conviction_token.cairo

```cairo
fn escrow(ref self: ContractState, from: ContractAddress, amount: u256) {
    self._assert_module();
    assert(amount > 0, 'ZeroAmount');
    self.erc20._transfer(from, get_contract_address(), amount);
}
```


selection.cairo
```cairo
stake_count: u256,
stakes: Map<u256, Stake>,
juror_stake_ids: Map<(ContractAddress, u32), u256>,
juror_stake_count: Map<ContractAddress, u32>,
```

selection.cairo
```cairo
let stake_count = self.juror_stake_count.entry(caller).read();
self.juror_stake_ids.entry((caller, stake_count)).write(stake_id);
self.juror_stake_count.entry(caller).write(stake_count + 1);
```
