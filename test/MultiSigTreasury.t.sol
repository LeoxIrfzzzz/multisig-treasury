// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MultiSigTreasury.sol";
import "../src/IMockVault.sol";

// --- MOCK CONTRACTS FOR TEST SUITE SELF-CONTAINMENT ---

contract MockERC20 is IERC20 {
    string public name = "Mock USDC";
    string public symbol = "mUSDC";
    uint8 public decimals = 6;
    uint256 public override totalSupply;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;

    function mint(address to, uint256 value) public {
        balanceOf[to] += value;
        totalSupply += value;
        emit Transfer(address(0), to, value);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (balanceOf[msg.sender] < value) revert("ERC20: transfer amount exceeds balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) public override returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (balanceOf[from] < value) revert("ERC20: transfer amount exceeds balance");
        if (allowance[from][msg.sender] != type(uint256).max) {
            if (allowance[from][msg.sender] < value) revert("ERC20: transfer amount exceeds allowance");
            allowance[from][msg.sender] -= value;
        }
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}

contract MockERC4626 is IMockVault {
    IERC20 public immutable underlying;
    uint256 public totalShares;
    mapping(address => uint256) public sharesBalance;
    mapping(address => mapping(address => uint256)) public shareAllowance;

    string public name = "Mock Yield Shares";
    string public symbol = "mSHARES";
    uint8 public decimals = 6;

    constructor(address _underlying) {
        underlying = IERC20(_underlying);
    }

    function asset() external view override returns (address) {
        return address(underlying);
    }

    function deposit(uint256 assets, address receiver) external override returns (uint256 shares) {
        underlying.transferFrom(msg.sender, address(this), assets);
        shares = convertToShares(assets);
        sharesBalance[receiver] += shares;
        totalShares += shares;
        emit Transfer(address(0), receiver, shares);
        return shares;
    }

    function withdraw(uint256 assets, address receiver, address owner) external override returns (uint256 shares) {
        shares = convertToShares(assets);
        if (sharesBalance[owner] < shares) revert("ERC4626: withdraw amount exceeds balance");
        if (msg.sender != owner && shareAllowance[owner][msg.sender] != type(uint256).max) {
            if (shareAllowance[owner][msg.sender] < shares) revert("ERC4626: withdraw amount exceeds allowance");
            shareAllowance[owner][msg.sender] -= shares;
        }
        sharesBalance[owner] -= shares;
        totalShares -= shares;
        underlying.transfer(receiver, assets);
        emit Transfer(owner, address(0), shares);
        return shares;
    }

    function balanceOf(address owner) external view override returns (uint256 shares) {
        return sharesBalance[owner];
    }

    function convertToAssets(uint256 shares) public pure override returns (uint256 assets) {
        return shares; // 1:1 asset-to-share parity for test predictability
    }

    function convertToShares(uint256 assets) public pure override returns (uint256 shares) {
        return assets;
    }

    // Standard ERC20 methods for shares
    function transfer(address to, uint256 amount) external override returns (bool) {
        if (sharesBalance[msg.sender] < amount) revert("ERC20: transfer amount exceeds balance");
        sharesBalance[msg.sender] -= amount;
        sharesBalance[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function allowance(address owner, address spender) external view override returns (uint256) {
        return shareAllowance[owner][spender];
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        shareAllowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        if (sharesBalance[from] < amount) revert("ERC20: transfer amount exceeds balance");
        if (shareAllowance[from][msg.sender] != type(uint256).max) {
            if (shareAllowance[from][msg.sender] < amount) revert("ERC20: transfer amount exceeds allowance");
            shareAllowance[from][msg.sender] -= amount;
        }
        sharesBalance[from] -= amount;
        sharesBalance[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function totalSupply() external view override returns (uint256) {
        return totalShares;
    }
}

// --- CORE FOUNDRY TEST SUITE ---

contract MultiSigTreasuryTest is Test {
    MultiSigTreasury public treasury;
    MockERC20 public usdc;
    MockERC4626 public vault;

    address[] public owners;
    address public owner1 = address(0x111);
    address public owner2 = address(0x222);
    address public owner3 = address(0x333);
    address public recipient = address(0xABC);

    uint256 public constant THRESHOLD = 2; // 2-of-3 Multi-Sig
    uint256 public constant TIME_LOCK_DELAY = 2 days; // 172800 seconds
    uint256 public constant TIME_LOCK_THRESHOLD_ETH = 10 ether;
    uint256 public constant TIME_LOCK_THRESHOLD_USDC = 10000 * 1e6; // 10,000 USDC (6 decimals)
    uint256 public constant MAX_IDLE_THRESHOLD = 5000 * 1e6; // 5,000 USDC

    function setUp() public {
        // Setup initial owners
        owners.push(owner1);
        owners.push(owner2);
        owners.push(owner3);

        // Deploy Mock USDC
        usdc = new MockERC20();

        // Deploy Mock Vault
        vault = new MockERC4626(address(usdc));

        // Deploy Multi-Signature Treasury
        treasury = new MultiSigTreasury(
            owners,
            THRESHOLD,
            TIME_LOCK_DELAY,
            TIME_LOCK_THRESHOLD_ETH,
            TIME_LOCK_THRESHOLD_USDC,
            address(usdc),
            address(vault),
            MAX_IDLE_THRESHOLD
        );

        // Fund treasury and recipient with USDC for testing
        usdc.mint(address(treasury), 25000 * 1e6); // 25,000 USDC
        usdc.mint(address(this), 10000 * 1e6); // 10,000 USDC
    }

    // --- UNIT TESTS ---

    function test_Initialization() public {
        assertEq(treasury.threshold(), THRESHOLD);
        assertEq(treasury.timeLockDelay(), TIME_LOCK_DELAY);
        assertEq(treasury.timeLockThresholdEth(), TIME_LOCK_THRESHOLD_ETH);
        assertEq(treasury.timeLockThresholdErc20(), TIME_LOCK_THRESHOLD_USDC);
        assertEq(address(treasury.erc20Token()), address(usdc));
        assertEq(address(treasury.yieldVault()), address(vault));
        assertEq(treasury.maxIdleThreshold(), MAX_IDLE_THRESHOLD);

        assertTrue(treasury.isOwner(owner1));
        assertTrue(treasury.isOwner(owner2));
        assertTrue(treasury.isOwner(owner3));
        assertFalse(treasury.isOwner(address(0x444)));
    }

    function test_ProposeTransaction() public {
        vm.prank(owner1);
        uint256 txId = treasury.proposeTransaction(recipient, 0, "", 1000 * 1e6); // 1,000 USDC

        (
            address to,
            uint256 value,
            ,
            uint256 erc20Amount,
            bool executed,
            uint256 confirmationCount,
            uint256 timeLockStart
        ) = treasury.getTransaction(txId);

        assertEq(to, recipient);
        assertEq(value, 0);
        assertEq(erc20Amount, 1000 * 1e6);
        assertFalse(executed);
        assertEq(confirmationCount, 1);
        assertEq(timeLockStart, 0); // Below threshold and time-lock threshold

        assertTrue(treasury.confirmations(txId, owner1));
        assertFalse(treasury.confirmations(txId, owner2));
    }

    function test_ConfirmTransaction() public {
        vm.prank(owner1);
        uint256 txId = treasury.proposeTransaction(recipient, 0, "", 1000 * 1e6);

        vm.prank(owner2);
        treasury.confirmTransaction(txId);

        (,,,,bool executed, uint256 confirmationCount, uint256 timeLockStart) = treasury.getTransaction(txId);
        assertEq(confirmationCount, 2);
        assertFalse(executed);
        assertEq(timeLockStart, 0); // No time-lock for low values
        assertTrue(treasury.confirmations(txId, owner2));
    }

    function test_RevokeConfirmation() public {
        vm.prank(owner1);
        uint256 txId = treasury.proposeTransaction(recipient, 0, "", 1000 * 1e6);

        vm.prank(owner2);
        treasury.confirmTransaction(txId);

        vm.prank(owner2);
        treasury.revokeConfirmation(txId);

        (,,,,,,uint256 confirmationCount) = treasury.getTransaction(txId);
        assertEq(confirmationCount, 1);
        assertFalse(treasury.confirmations(txId, owner2));
    }

    function test_TimeLockEnforcementAndBypassPrevention() public {
        // Propose a large transaction above time-lock threshold (15,000 USDC > 10,000 USDC)
        vm.prank(owner1);
        uint256 txId = treasury.proposeTransaction(recipient, 0, "", 15000 * 1e6);

        vm.prank(owner2);
        treasury.confirmTransaction(txId); // Reaches 2 confirmations (Threshold met)

        (,,,,,,uint256 timeLockStart) = treasury.getTransaction(txId);
        assertEq(timeLockStart, block.timestamp);

        // Attempt execution immediately (Should revert)
        vm.prank(owner1);
        vm.expectRevert(MultiSigTreasury.MultiSig__TimeLockNotPassed.selector);
        treasury.executeTransaction(txId);

        // Warp to 1 second before unlock delay
        vm.warp(block.timestamp + TIME_LOCK_DELAY - 1);
        vm.prank(owner1);
        vm.expectRevert(MultiSigTreasury.MultiSig__TimeLockNotPassed.selector);
        treasury.executeTransaction(txId);

        // Warp past unlock delay (2 days)
        vm.warp(block.timestamp + 2); // 1 + 2 exceeds delay
        vm.prank(owner1);
        treasury.executeTransaction(txId); // Should execute successfully

        (,,, ,bool executed,,) = treasury.getTransaction(txId);
        assertTrue(executed);
        assertEq(usdc.balanceOf(recipient), 15000 * 1e6);
    }

    function test_TimeLockResetOnRevocation() public {
        // Propose transaction requiring time-lock
        vm.prank(owner1);
        uint256 txId = treasury.proposeTransaction(recipient, 0, "", 15000 * 1e6);

        vm.prank(owner2);
        treasury.confirmTransaction(txId); // Reaches threshold, starts time-lock

        (,,,,,,uint256 timeLockStartBefore) = treasury.getTransaction(txId);
        assertEq(timeLockStartBefore, block.timestamp);

        // Revoke confirmation (Drops below threshold)
        vm.prank(owner2);
        treasury.revokeConfirmation(txId);

        (,,,,,,uint256 timeLockStartAfter) = treasury.getTransaction(txId);
        assertEq(timeLockStartAfter, 0); // Resets to 0

        // Attempt execution (Should revert with ThresholdNotReached)
        vm.prank(owner1);
        vm.expectRevert(MultiSigTreasury.MultiSig__ThresholdNotReached.selector);
        treasury.executeTransaction(txId);
    }

    // --- INTEGRATION TESTS ---

    function test_Integration_IdleDepositAndDynamicDeficitRouting() public {
        // 1. Check initial treasury balance (25,000 USDC)
        assertEq(usdc.balanceOf(address(treasury)), 25000 * 1e6);
        assertEq(vault.balanceOf(address(treasury)), 0);

        // 2. Deposit idle funds (Publicly callable by anyone)
        // Max idle threshold is 5,000 USDC. Excess of 20,000 USDC should go to vault.
        treasury.depositIdleFunds();

        assertEq(usdc.balanceOf(address(treasury)), 5000 * 1e6); // Kept 5,000 USDC liquid
        assertEq(vault.balanceOf(address(treasury)), 20000 * 1e6); // Yield routing deposited 20,000 USDC

        // 3. Propose a transaction for 12,000 USDC (Requires routing deficit of 7,000 USDC from vault)
        vm.prank(owner1);
        uint256 txId = treasury.proposeTransaction(recipient, 0, "", 12000 * 1e6);

        vm.prank(owner2);
        treasury.confirmTransaction(txId); // Time-lock active (12,000 > 10,000)

        // 4. Warp past time-lock delay
        vm.warp(block.timestamp + TIME_LOCK_DELAY + 1);

        // 5. Execute transaction (Synchronously draws deficit and executes transfer)
        vm.prank(owner1);
        treasury.executeTransaction(txId);

        // 6. Verify balances
        // Required: 12,000 USDC. Internal balance was 5,000 USDC.
        // Deficit = 7,000 USDC withdrawn from Vault.
        // Vault shares should drop by 7,000 USDC (from 20k to 13k).
        // Treasury internal balance should drop to 0.
        // Recipient should receive 12,000 USDC.
        assertEq(usdc.balanceOf(recipient), 12000 * 1e6);
        assertEq(usdc.balanceOf(address(treasury)), 0);
        assertEq(vault.balanceOf(address(treasury)), 13000 * 1e6);
    }

    // --- FUZZ TESTING ---

    /**
     * @notice Security Invariant Fuzz Test
     * Validates that the treasury can never execute a transaction requesting more than
     * the total combined capital available (liquid treasury balance + yield vault balance).
     */
    function testFuzz_CannotWithdrawBeyondBalance(uint256 _fuzzErc20Amount) public {
        // Limit fuzz amount to prevent overflow issues on total balances
        vm.assume(_fuzzErc20Amount > 25000 * 1e6 && _fuzzErc20Amount < 1000000000 * 1e6);

        // Initial setup: deposit idle capital
        treasury.depositIdleFunds(); // Treasury liquid: 5,000, Vault: 20,000 (Total: 25,000 USDC)

        // Propose transaction with fuzzed amount > 25,000 USDC
        vm.prank(owner1);
        uint256 txId = treasury.proposeTransaction(recipient, 0, "", _fuzzErc20Amount);

        vm.prank(owner2);
        treasury.confirmTransaction(txId);

        // Warp past time lock
        vm.warp(block.timestamp + TIME_LOCK_DELAY + 1);

        // Attempt execution (Must revert with NotEnoughBalance)
        vm.prank(owner1);
        vm.expectRevert(MultiSigTreasury.MultiSig__NotEnoughBalance.selector);
        treasury.executeTransaction(txId);
    }
}
