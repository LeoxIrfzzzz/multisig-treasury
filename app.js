/* ==========================================================================
   AETHERIS EVM CLIENT & INTERACTIVE WEB APP ENGINE
   Engineered by Mohammed Irfaan
   ========================================================================== */

// --- SOLIDITY CODEBASE STRINGS FOR SOURCE VIEW TAB ---
const CODEBASE = {
    "IMockVault.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IMockVault (ERC-4626 Tokenized Vault Interface)
 * @author Principal Web3 Architect & Senior Solidity Engineer
 * @notice Interface for a standard ERC-4626 vault used to route idle capital for yielding.
 * @dev Combines standard ERC-20 shares logic with asset management hooks.
 */
interface IMockVault is IERC20 {
    /**
     * @notice Returns the address of the underlying token used for the vault.
     * @return assetTokenAddress The address of the underlying ERC-20 asset.
     */
    function asset() external view returns (address assetTokenAddress);

    /**
     * @notice Deposits a given amount of underlying assets into the vault and mints shares to the receiver.
     * @param assets The amount of underlying assets to deposit.
     * @param receiver The address that will receive the minted shares.
     * @return shares The amount of shares minted.
     */
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);

    /**
     * @notice Withdraws a specific amount of underlying assets from the vault and burns owner's shares.
     * @param assets The amount of underlying assets to withdraw.
     * @param receiver The address receiving the underlying assets.
     * @param owner The owner of the shares being burned.
     * @return shares The amount of shares burned.
     */
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);

    /**
     * @notice Converts a specific amount of shares to the equivalent amount of underlying assets.
     * @param shares The amount of shares to convert.
     * @return assets The equivalent amount of underlying assets.
     */
    function convertToAssets(uint256 shares) external view returns (uint256 assets);

    /**
     * @notice Converts a specific amount of underlying assets to the equivalent amount of shares.
     * @param assets The amount of underlying assets to convert.
     * @return shares The equivalent amount of shares.
     */
    function convertToShares(uint256 assets) external view returns (uint256 shares);
}`,

    "MultiSigTreasury.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IMockVault.sol";

/**
 * @title MultiSigTreasury
 * @author Principal Web3 Architect & Senior Solidity Engineer
 * @notice A secure, gas-optimized Multi-Signature Treasury contract featuring Time-Lock controls
 *         for large transactions and automated capital-efficient Yield Routing to an ERC-4626 vault.
 */
contract MultiSigTreasury is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- STRUCTS ---

    struct Transaction {
        address to;             // Target address of the call/transfer
        uint256 value;          // Amount of native Ether to send
        bytes data;             // Transaction payload for target contract execution
        uint256 erc20Amount;    // Amount of the managed ERC-20 token to transfer
        bool executed;          // Whether the transaction has been executed
        uint256 confirmationCount; // Number of active owner confirmations
        uint256 timeLockStart;  // Timestamp when confirmation threshold was met (0 if not active)
    }

    // --- STATE VARIABLES ---

    // Governance parameters
    address[] public owners;
    mapping(address => bool) public isOwner;
    uint256 public immutable threshold;

    // Time-lock parameters
    uint256 public immutable timeLockDelay;
    uint256 public immutable timeLockThresholdEth;
    uint256 public immutable timeLockThresholdErc20;

    // Capital efficiency and yield parameters
    IERC20 public immutable erc20Token;
    IMockVault public immutable yieldVault;
    uint256 public immutable maxIdleThreshold;

    // Transaction registry
    Transaction[] public transactions;
    // txId => owner => hasConfirmed
    mapping(uint256 => mapping(address => bool)) public confirmations;

    // --- EVENTS ---

    event TxProposed(uint256 indexed txId, address indexed proposer, address indexed to, uint256 value, uint256 erc20Amount);
    event TxConfirmed(uint256 indexed txId, address indexed owner);
    event ConfirmationRevoked(uint256 indexed txId, address indexed owner);
    event TimeLockStarted(uint256 indexed txId, uint256 startTime);
    event TimeLockCancelled(uint256 indexed txId);
    event TxExecuted(uint256 indexed txId, address indexed executor);
    event YieldDeposited(uint256 assets, uint256 shares);
    event YieldWithdrawn(uint256 assets);

    // --- CUSTOM ERRORS ---

    error MultiSig__NotOwner();
    error MultiSig__InvalidThreshold();
    error MultiSig__InvalidOwnersLength();
    error MultiSig__OwnerNotUnique();
    error MultiSig__ZeroAddress();
    error MultiSig__TxDoesNotExist();
    error MultiSig__TxAlreadyExecuted();
    error MultiSig__TxAlreadyConfirmed();
    error MultiSig__TxNotConfirmed();
    error MultiSig__TimeLockNotPassed();
    error MultiSig__TimeLockNotActive();
    error MultiSig__ThresholdNotReached();
    error MultiSig__AssetMismatch();
    error MultiSig__NoIdleFundsToDeposit();
    error MultiSig__IdleDepositFailed();
    error MultiSig__ExecutionFailed(bytes returnData);
    error MultiSig__NotEnoughBalance();

    // --- MODIFIERS ---

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert MultiSig__NotOwner();
        _;
    }

    modifier txExists(uint256 _txId) {
        if (_txId >= transactions.length) revert MultiSig__TxDoesNotExist();
        _;
    }

    modifier notExecuted(uint256 _txId) {
        if (transactions[_txId].executed) revert MultiSig__TxAlreadyExecuted();
        _;
    }

    modifier notConfirmed(uint256 _txId, address _owner) {
        if (confirmations[_txId][_owner]) revert MultiSig__TxAlreadyConfirmed();
        _;
    }

    modifier confirmed(uint256 _txId, address _owner) {
        if (!confirmations[_txId][_owner]) revert MultiSig__TxNotConfirmed();
        _;
    }

    // --- CONSTRUCTOR ---

    constructor(
        address[] memory _owners,
        uint256 _threshold,
        uint256 _timeLockDelay,
        uint256 _timeLockThresholdEth,
        uint256 _timeLockThresholdErc20,
        address _erc20Token,
        address _yieldVault,
        uint256 _maxIdleThreshold
    ) {
        if (_owners.length == 0) revert MultiSig__InvalidOwnersLength();
        if (_threshold == 0 || _threshold > _owners.length) revert MultiSig__InvalidThreshold();
        if (_erc20Token == address(0) || _yieldVault == address(0)) revert MultiSig__ZeroAddress();
        if (IMockVault(_yieldVault).asset() != _erc20Token) revert MultiSig__AssetMismatch();

        uint256 numOwners = _owners.length;
        for (uint256 i = 0; i < numOwners; ++i) {
            address owner = _owners[i];
            if (owner == address(0)) revert MultiSig__ZeroAddress();
            if (isOwner[owner]) revert MultiSig__OwnerNotUnique();
            isOwner[owner] = true;
            owners.push(owner);
        }

        threshold = _threshold;
        timeLockDelay = _timeLockDelay;
        timeLockThresholdEth = _timeLockThresholdEth;
        timeLockThresholdErc20 = _timeLockThresholdErc20;
        erc20Token = IERC20(_erc20Token);
        yieldVault = IMockVault(_yieldVault);
        maxIdleThreshold = _maxIdleThreshold;
    }

    // --- GOVERNANCE FLOW ---

    function proposeTransaction(
        address _to,
        uint256 _value,
        bytes calldata _data,
        uint256 _erc20Amount
    ) external onlyOwner returns (uint256 txId) {
        if (_to == address(0)) revert MultiSig__ZeroAddress();

        txId = transactions.length;
        transactions.push(Transaction({
            to: _to,
            value: _value,
            data: _data,
            erc20Amount: _erc20Amount,
            executed: false,
            confirmationCount: 1,
            timeLockStart: 0
        }));

        confirmations[txId][msg.sender] = true;

        emit TxProposed(txId, msg.sender, _to, _value, _erc20Amount);
        emit TxConfirmed(txId, msg.sender);

        if (threshold == 1) {
            if (_value > timeLockThresholdEth || _erc20Amount > timeLockThresholdErc20) {
                transactions[txId].timeLockStart = block.timestamp;
                emit TimeLockStarted(txId, block.timestamp);
            }
        }
    }

    function confirmTransaction(uint256 _txId)
        external
        onlyOwner
        txExists(_txId)
        notExecuted(_txId)
        notConfirmed(_txId, msg.sender)
    {
        Transaction storage transaction = transactions[_txId];
        confirmations[_txId][msg.sender] = true;
        transaction.confirmationCount++;

        emit TxConfirmed(_txId, msg.sender);

        if (transaction.confirmationCount >= threshold && transaction.timeLockStart == 0) {
            if (transaction.value > timeLockThresholdEth || transaction.erc20Amount > timeLockThresholdErc20) {
                transaction.timeLockStart = block.timestamp;
                emit TimeLockStarted(_txId, block.timestamp);
            }
        }
    }

    function revokeConfirmation(uint256 _txId)
        external
        onlyOwner
        txExists(_txId)
        notExecuted(_txId)
        confirmed(_txId, msg.sender)
    {
        Transaction storage transaction = transactions[_txId];
        confirmations[_txId][msg.sender] = false;
        transaction.confirmationCount--;

        emit ConfirmationRevoked(_txId, msg.sender);

        if (transaction.confirmationCount < threshold && transaction.timeLockStart != 0) {
            transaction.timeLockStart = 0;
            emit TimeLockCancelled(_txId);
        }
    }

    function executeTransaction(uint256 _txId)
        external
        onlyOwner
        nonReentrant
        txExists(_txId)
        notExecuted(_txId)
    {
        Transaction storage transaction = transactions[_txId];

        if (transaction.confirmationCount < threshold) revert MultiSig__ThresholdNotReached();

        bool requiresTimeLock = (transaction.value > timeLockThresholdEth || transaction.erc20Amount > timeLockThresholdErc20);
        if (requiresTimeLock) {
            if (transaction.timeLockStart == 0) revert MultiSig__TimeLockNotActive();
            if (block.timestamp < transaction.timeLockStart + timeLockDelay) revert MultiSig__TimeLockNotPassed();
        }

        transaction.executed = true;

        if (transaction.erc20Amount > 0) {
            uint256 internalBalance = erc20Token.balanceOf(address(this));
            if (internalBalance < transaction.erc20Amount) {
                uint256 deficit = transaction.erc20Amount - internalBalance;
                
                uint256 vaultShares = yieldVault.balanceOf(address(this));
                uint256 vaultAssets = yieldVault.convertToAssets(vaultShares);
                
                if (internalBalance + vaultAssets < transaction.erc20Amount) revert MultiSig__NotEnoughBalance();

                yieldVault.withdraw(deficit, address(this), address(this));
                emit YieldWithdrawn(deficit);
            }

            erc20Token.safeTransfer(transaction.to, transaction.erc20Amount);
        }

        if (transaction.value > 0 || transaction.data.length > 0) {
            (bool success, bytes memory returnData) = transaction.to.call{value: transaction.value}(transaction.data);
            if (!success) revert MultiSig__ExecutionFailed(returnData);
        }

        emit TxExecuted(_txId, msg.sender);
    }

    // --- CAPITAL ROUTER ---

    function depositIdleFunds() external nonReentrant {
        uint256 balance = erc20Token.balanceOf(address(this));
        if (balance <= maxIdleThreshold) revert MultiSig__NoIdleFundsToDeposit();

        uint256 idleAmount = balance - maxIdleThreshold;

        erc20Token.safeApprove(address(yieldVault), 0);
        erc20Token.safeApprove(address(yieldVault), idleAmount);

        uint256 shares = yieldVault.deposit(idleAmount, address(this));
        if (shares == 0) revert MultiSig__IdleDepositFailed();

        emit YieldDeposited(idleAmount, shares);
    }

    receive() external payable {}
    fallback() external payable {}
}`,

    "MultiSigTreasury.t.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MultiSigTreasury.sol";
import "../src/IMockVault.sol";

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
    uint256 public constant TIME_LOCK_DELAY = 2 days;
    uint256 public constant TIME_LOCK_THRESHOLD_ETH = 10 ether;
    uint256 public constant TIME_LOCK_THRESHOLD_USDC = 10000 * 1e6;
    uint256 public constant MAX_IDLE_THRESHOLD = 5000 * 1e6;

    function setUp() public {
        owners.push(owner1);
        owners.push(owner2);
        owners.push(owner3);

        usdc = new MockERC20();
        vault = new MockERC4626(address(usdc));

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

        usdc.mint(address(treasury), 25000 * 1e6);
    }

    function test_TimeLockEnforcementAndBypassPrevention() public {
        vm.prank(owner1);
        uint256 txId = treasury.proposeTransaction(recipient, 0, "", 15000 * 1e6);

        vm.prank(owner2);
        treasury.confirmTransaction(txId);

        vm.warp(block.timestamp + TIME_LOCK_DELAY - 1);
        vm.prank(owner1);
        vm.expectRevert(MultiSigTreasury.MultiSig__TimeLockNotPassed.selector);
        treasury.executeTransaction(txId);

        vm.warp(block.timestamp + 2);
        vm.prank(owner1);
        treasury.executeTransaction(txId);

        assertTrue(treasury.transactions(txId).executed);
    }

    function test_Integration_IdleDepositAndDynamicDeficitRouting() public {
        treasury.depositIdleFunds();

        assertEq(usdc.balanceOf(address(treasury)), 5000 * 1e6);
        assertEq(vault.balanceOf(address(treasury)), 20000 * 1e6);

        vm.prank(owner1);
        uint256 txId = treasury.proposeTransaction(recipient, 0, "", 12000 * 1e6);

        vm.prank(owner2);
        treasury.confirmTransaction(txId);

        vm.warp(block.timestamp + TIME_LOCK_DELAY + 1);

        vm.prank(owner1);
        treasury.executeTransaction(txId);

        assertEq(usdc.balanceOf(recipient), 12000 * 1e6);
        assertEq(usdc.balanceOf(address(treasury)), 0);
        assertEq(vault.balanceOf(address(treasury)), 13000 * 1e6);
    }
}`
};

// --- STEPPER STAGE CONTENT DATA ---
const STEPPER_STAGES = [
    {
        title: "Stage 1: Proposal Submission & Pre-Confirmation",
        narrative: "An owner initiates the transaction sequence by calling <code>proposeTransaction</code>. They submit the transaction recipient, the Ether value to send, execution calldata bytes, and the managed ERC-20 token amount. To optimize gas efficiency, the proposer's confirmation signature is registered automatically in the same call state, triggering the initial <code>TxProposed</code> and <code>TxConfirmed</code> events.",
        snippet: `// Proposer auto-signs in storage to conserve write gas
confirmations[txId][msg.sender] = true;
transactions.push(Transaction({
    to: _to,
    value: _value,
    erc20Amount: _erc20Amount,
    executed: false,
    confirmationCount: 1,
    timeLockStart: 0
}));`,
        gas: "~105,000 gas (initial storage allocation + auto-signature)",
        rule: "requires msg.sender to be verified owner & _to != address(0)"
    },
    {
        title: "Stage 2: Quorum Consensual Approvals",
        narrative: "Other authorized multisig owners review the transaction details in queue. To approve, they call <code>confirmTransaction</code>, incrementing the confirmation count. If the confirmation count reaches the execution threshold (e.g. 2-of-3), and the asset transfer exceeds our time-lock limits, the smart contract registers the active timestamp. Conversely, if an owner revokes confirmation before execution, dropping approvals below the threshold, the timer is cleared.",
        snippet: `// Reaching threshold activates the time-lock countdown
if (transaction.confirmationCount >= threshold && transaction.timeLockStart == 0) {
    if (transaction.value > timeLockThresholdEth || transaction.erc20Amount > timeLockThresholdErc20) {
        transaction.timeLockStart = block.timestamp;
        emit TimeLockStarted(_txId, block.timestamp);
    }
}`,
        gas: "~32,000 gas per approval (storage write updates)",
        rule: "transaction.executed == false & isOwner[msg.sender]"
    },
    {
        title: "Stage 3: Time-Lock Governance Countdown",
        narrative: "Large transfers (e.g. transactions > 10,000 USDC or > 10 ETH) undergo a mandatory cooling-off period of 2 days. This duration provides a crucial defense buffer: if keys are compromised or an unauthorized transaction is pushed, remaining owners have ample time to detect the threat, coordinate, revoke their confirmations, reset the time-lock start timer, and block execution entirely.",
        snippet: `// Hard check validating that the time-lock cooling duration has passed
if (block.timestamp < transaction.timeLockStart + timeLockDelay) {
    revert MultiSig__TimeLockNotPassed();
}`,
        gas: "0 gas (governance delay, validated off-chain, checked at execution)",
        rule: "block.timestamp >= transaction.timeLockStart + 2 days"
    },
    {
        title: "Stage 4: Automated Deficit Yield Routing",
        narrative: "When execution is called, if the internal liquid balance of the treasury is insufficient to settle the requested ERC-20 transfer, the contract calculates the exact deficit. It checks the vault's assets, burns a precise portion of shares, and withdraws the deficit underlying tokens in the *same transaction call lifecycle*. This ensures bulk treasury assets stay constantly yield-producing inside the ERC-4626 vault.",
        snippet: `// Synchronous deficit pull from yielding vault
if (internalBalance < transaction.erc20Amount) {
    uint256 deficit = transaction.erc20Amount - internalBalance;
    // ... validates vault share capacity ...
    yieldVault.withdraw(deficit, address(this), address(this));
    emit YieldWithdrawn(deficit);
}`,
        gas: "~75,000 - 110,000 gas (vault withdrawal + share burns)",
        rule: "internalBalance + vaultAssets >= transaction.erc20Amount"
    },
    {
        title: "Stage 5: Final Settlement & Payload Calls",
        narrative: "In the final execution block, the contract transfers the complete ERC-20 tokens to the recipient. If the transaction proposed a native Ether value or custom calldata, it executes a low-level target contract call. The execution is marked `executed = true` *prior* to external calls (CEI pattern), and the `TxExecuted` event is logged to the blockchain.",
        snippet: `// CEI completed: execute low level payload call
transaction.executed = true;
if (transaction.value > 0 || transaction.data.length > 0) {
    (bool success, bytes memory returnData) = transaction.to.call{value: transaction.value}(transaction.data);
    if (!success) revert MultiSig__ExecutionFailed(returnData);
}
emit TxExecuted(_txId, msg.sender);`,
        gas: "~45,000 gas base + destination execution payload call",
        rule: "requires nonReentrant guard mutex & threshold confirmations"
    }
];

// --- DASHBOARD SIMULATOR STATES ---
let treasuryUSDC = 25000.00;
let vaultShares = 0.00;
let exchangeRate = 1.00;
let virtualYieldEarned = 0.00;

let transactions = [];
let activeOwnerIdx = 0;
let simulatedTimeOffset = 0;

// --- UTILS ---
function formatUSDC(val) {
    return val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getActiveOwner() {
    return OWNERS[activeOwnerIdx];
}

function getEVMTime() {
    return Math.floor(Date.now() / 1000) + simulatedTimeOffset;
}

// --- EXPLORER LOGGER ---
function logToConsole(text, type = 'info') {
    const logsContainer = document.getElementById('terminal-logs');
    if (!logsContainer) return;

    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;

    const timestamp = new Date().toLocaleTimeString();
    entry.innerHTML = `<span class="timestamp">[${timestamp}]</span> ${text}`;
    
    logsContainer.appendChild(entry);
    logsContainer.scrollTop = logsContainer.scrollHeight;
}

// --- SANDBOX LOGIC SIMULATIONS ---

function depositIdleFundsSim() {
    logToConsole(`[Transaction Call] msg.sender=${getActiveOwner().address.slice(0, 10)}... -> depositIdleFunds()`, 'info');
    
    if (treasuryUSDC <= MAX_IDLE_THRESHOLD) {
        logToConsole(`[REVERT] MultiSig__NoIdleFundsToDeposit(): Current Liquid (${treasuryUSDC} USDC) <= Limit (${MAX_IDLE_THRESHOLD} USDC)`, 'error');
        return false;
    }

    const idleAmount = treasuryUSDC - MAX_IDLE_THRESHOLD;
    const gasSpent = Math.floor(Math.random() * 15000) + 65000;

    treasuryUSDC = MAX_IDLE_THRESHOLD;
    const sharesMinted = idleAmount / exchangeRate;
    vaultShares += sharesMinted;

    logToConsole(`[Event Emit] YieldDeposited(assets=${formatUSDC(idleAmount)}, shares=${formatUSDC(sharesMinted)})`, 'event');
    logToConsole(`[Success] depositIdleFunds() completed. Gas spent: ${gasSpent}`, 'success');

    updateUI();
    return true;
}

function proposeTransactionSim(to, valueEth, erc20Amount, data = "0x") {
    const sender = getActiveOwner();
    logToConsole(`[Transaction Call] sender=${sender.address.slice(0, 10)}... -> proposeTransaction(...)`, 'info');

    if (!to || to.length < 20 || to === "0x0000000000000000000000000000000000000000") {
        logToConsole(`[REVERT] MultiSig__ZeroAddress()`, 'error');
        return false;
    }

    const txId = transactions.length;
    
    const newTx = {
        id: txId,
        to: to,
        value: valueEth,
        erc20Amount: erc20Amount,
        data: data,
        executed: false,
        confirmations: {},
        confirmationCount: 1,
        timeLockStart: 0
    };

    newTx.confirmations[sender.address] = true;
    transactions.push(newTx);

    logToConsole(`[Event Emit] TxProposed(txId=${txId}, proposer=${sender.address.slice(0, 8)}..., to=${to.slice(0, 8)}...)`, 'event');
    logToConsole(`[Event Emit] TxConfirmed(txId=${txId}, owner=${sender.address.slice(0, 8)}...)`, 'event');

    logToConsole(`[Success] Tx #${txId} Registered. Pending consensus approvals.`, 'success');
    updateUI();
    return true;
}

function confirmTransactionSim(txId) {
    const sender = getActiveOwner();
    const tx = transactions[txId];
    
    logToConsole(`[Transaction Call] sender=${sender.address.slice(0, 10)}... -> confirmTransaction(txId=${txId})`, 'info');

    if (!tx) return;
    if (tx.executed || tx.confirmations[sender.address]) return;

    tx.confirmations[sender.address] = true;
    tx.confirmationCount++;

    logToConsole(`[Event Emit] TxConfirmed(txId=${txId}, owner=${sender.address.slice(0, 8)}...)`, 'event');

    // Time-Lock activation check
    if (tx.confirmationCount >= THRESHOLD && tx.timeLockStart === 0) {
        const requiresTimeLock = (tx.value > TIME_LOCK_THRESHOLD_ETH || tx.erc20Amount > TIME_LOCK_THRESHOLD_USDC);
        if (requiresTimeLock) {
            tx.timeLockStart = getEVMTime();
            logToConsole(`[Event Emit] TimeLockStarted(txId=${txId}, startTime=${tx.timeLockStart})`, 'event');
            logToConsole(`[Security Control] Delay countdown active. Transaction time-locked.`, 'info');
        }
    }

    updateUI();
}

function revokeConfirmationSim(txId) {
    const sender = getActiveOwner();
    const tx = transactions[txId];

    logToConsole(`[Transaction Call] sender=${sender.address.slice(0, 10)}... -> revokeConfirmation(txId=${txId})`, 'info');

    if (!tx) return;
    if (tx.executed || !tx.confirmations[sender.address]) return;

    tx.confirmations[sender.address] = false;
    tx.confirmationCount--;

    logToConsole(`[Event Emit] ConfirmationRevoked(txId=${txId}, owner=${sender.address.slice(0, 8)}...)`, 'event');

    if (tx.confirmationCount < THRESHOLD && tx.timeLockStart !== 0) {
        tx.timeLockStart = 0;
        logToConsole(`[Event Emit] TimeLockCancelled(txId=${txId})`, 'event');
        logToConsole(`[Security Control] Approvals below threshold. Time-Lock delay reset.`, 'error');
    }

    updateUI();
}

function executeTransactionSim(txId) {
    const sender = getActiveOwner();
    const tx = transactions[txId];

    logToConsole(`[Transaction Call] sender=${sender.address.slice(0, 10)}... -> executeTransaction(txId=${txId})`, 'info');

    if (!tx) return;
    if (tx.executed || tx.confirmationCount < THRESHOLD) return;

    const requiresTimeLock = (tx.value > TIME_LOCK_THRESHOLD_ETH || tx.erc20Amount > TIME_LOCK_THRESHOLD_USDC);
    if (requiresTimeLock) {
        if (tx.timeLockStart === 0) return;
        const unlockTime = tx.timeLockStart + TIME_LOCK_DELAY;
        const currentEVMTime = getEVMTime();
        if (currentEVMTime < unlockTime) {
            logToConsole(`[REVERT] MultiSig__TimeLockNotPassed(): Cooling period active.`, 'error');
            return;
        }
    }

    // Dynamic Deficit route
    if (tx.erc20Amount > 0) {
        const vaultAssets = vaultShares * exchangeRate;
        if (treasuryUSDC < tx.erc20Amount) {
            const deficit = tx.erc20Amount - treasuryUSDC;
            
            if (treasuryUSDC + vaultAssets < tx.erc20Amount) {
                logToConsole(`[REVERT] MultiSig__NotEnoughBalance()`, 'error');
                return;
            }

            // Withdraw from vault
            const sharesBurned = deficit / exchangeRate;
            vaultShares -= sharesBurned;
            treasuryUSDC += deficit;

            logToConsole(`[Yield Deficit Route] Routed deficit of ${formatUSDC(deficit)} USDC from Yield Vault.`, 'info');
            logToConsole(`[Event Emit] YieldWithdrawn(assets=${formatUSDC(deficit)})`, 'event');
        }
        treasuryUSDC -= tx.erc20Amount;
    }

    tx.executed = true;
    
    logToConsole(`[Event Emit] TxExecuted(txId=${txId}, executor=${sender.address.slice(0, 8)}...)`, 'event');
    logToConsole(`[Success] Tx #${txId} executed successfully!`, 'success');

    updateUI();
}

function accrueYield() {
    if (vaultShares === 0) {
        logToConsole(`[Simulation Warning] Vault balance is 0. Deposit idle capital first!`, 'error');
        return;
    }
    const previousAssets = vaultShares * exchangeRate;
    exchangeRate *= 1.05;
    const newAssets = vaultShares * exchangeRate;
    const gained = newAssets - previousAssets;
    virtualYieldEarned += gained;

    logToConsole(`[Yield Protocol] Vault Accrued Interest! Rate increased to ${exchangeRate.toFixed(4)} USDC/share.`, 'success');
    logToConsole(`[Yield Protocol] Treasury accrued +${formatUSDC(gained)} USDC of interest yield!`, 'success');
    updateUI();
}

function faucetUSDC() {
    treasuryUSDC += 10000.00;
    logToConsole(`[Faucet Call] Minted +10,000.00 USDC to MultiSigTreasury balance.`, 'success');
    updateUI();
}

function timeWarpSim(txId) {
    simulatedTimeOffset += TIME_LOCK_DELAY;
    logToConsole(`[VM Action] Warp EVM Time ahead by 2 Days (+172,800s).`, 'success');
    updateUI();
}

// --- RENDERING VIEWS ---

function updateUI() {
    // Balance displays
    const vaultAssets = vaultShares * exchangeRate;
    const combinedTotal = treasuryUSDC + vaultAssets;

    const elCombined = document.getElementById('combined-balance');
    if (elCombined) {
        elCombined.textContent = formatUSDC(combinedTotal);
        document.getElementById('treasury-liquid').textContent = formatUSDC(treasuryUSDC);
        document.getElementById('vault-assets').textContent = formatUSDC(vaultAssets);
        document.getElementById('yield-earned').textContent = formatUSDC(virtualYieldEarned);

        const progressPercent = Math.min((treasuryUSDC / MAX_IDLE_THRESHOLD) * 100, 100);
        const progressBar = document.getElementById('idle-progress');
        const idleStatus = document.getElementById('idle-status');
        const currentLiquidMetric = document.getElementById('current-liquid-metric');
        
        progressBar.style.width = `${progressPercent}%`;
        currentLiquidMetric.textContent = formatUSDC(treasuryUSDC);

        if (treasuryUSDC > MAX_IDLE_THRESHOLD) {
            progressBar.className = "progress-bar excess";
            idleStatus.className = "status-warning";
            idleStatus.textContent = `Surplus: +${formatUSDC(treasuryUSDC - MAX_IDLE_THRESHOLD)} USDC!`;
            document.getElementById('btn-deposit-idle').disabled = false;
            document.getElementById('btn-deposit-idle').classList.add('glow-animation');
        } else {
            progressBar.className = "progress-bar";
            idleStatus.className = "status-normal";
            idleStatus.textContent = "Optimal liquid balance maintained.";
            document.getElementById('btn-deposit-idle').disabled = true;
            document.getElementById('btn-deposit-idle').classList.remove('glow-animation');
        }
    }

    // Timeline queue renderer
    const timeline = document.getElementById('tx-timeline');
    if (timeline) {
        const emptyState = document.getElementById('tx-list-empty');
        timeline.innerHTML = "";

        if (transactions.length === 0) {
            emptyState.style.display = "flex";
        } else {
            emptyState.style.display = "none";
            
            transactions.forEach(tx => {
                const card = document.createElement('div');
                card.className = `tx-card ${tx.executed ? 'executed' : ''}`;
                
                let avatarsHtml = "";
                OWNERS.forEach(owner => {
                    const hasSigned = tx.confirmations[owner.address] === true;
                    avatarsHtml += `<div class="mini-avatar ${owner.avatar.toLowerCase()} ${hasSigned ? 'active' : ''}" title="${owner.name} (${hasSigned ? 'Signed' : 'Unsigned'})">${owner.avatar}</div>`;
                });

                let statusText = "Pending approvals";
                let statusClass = "status-badge-pending";
                let actionBtnHtml = "";
                let timeLockHtml = "";

                const requiresTimeLock = (tx.value > TIME_LOCK_THRESHOLD_ETH || tx.erc20Amount > TIME_LOCK_THRESHOLD_USDC);
                
                if (tx.executed) {
                    statusText = "Executed";
                    statusClass = "status-badge-executed";
                } else if (tx.confirmationCount >= THRESHOLD) {
                    if (requiresTimeLock) {
                        const unlockTime = tx.timeLockStart + TIME_LOCK_DELAY;
                        const currentEVM = getEVMTime();
                        if (currentEVM >= unlockTime) {
                            statusText = "Time-Lock Passed";
                            statusClass = "status-badge-ready";
                            timeLockHtml = `<span class="timelock-timer passed">⏱️ Delay complete</span>`;
                            actionBtnHtml += `<button class="btn btn-primary btn-sm glow-animation" onclick="executeTransactionSim(${tx.id})">Execute</button>`;
                        } else {
                            statusText = "Time-Locked";
                            statusClass = "status-badge-locked";
                            const left = unlockTime - currentEVM;
                            const hours = Math.floor(left / 3600);
                            const minutes = Math.floor((left % 3600) / 60);
                            timeLockHtml = `<span class="timelock-timer">⏱️ Locked: ${hours}h ${minutes}m left</span>`;
                            actionBtnHtml += `<button class="btn btn-outline btn-xs" onclick="timeWarpSim(${tx.id})">⚡ Warp Time</button>`;
                        }
                    } else {
                        statusText = "Ready to Execute";
                        statusClass = "status-badge-ready";
                        actionBtnHtml += `<button class="btn btn-primary btn-sm glow-animation" onclick="executeTransactionSim(${tx.id})">Execute</button>`;
                    }
                }

                if (!tx.executed) {
                    const currentOwner = getActiveOwner();
                    const alreadySigned = tx.confirmations[currentOwner.address] === true;
                    
                    if (alreadySigned) {
                        actionBtnHtml = `<button class="btn btn-danger-outline btn-sm" onclick="revokeConfirmationSim(${tx.id})">Revoke Approval</button>` + actionBtnHtml;
                    } else {
                        actionBtnHtml = `<button class="btn btn-success-outline btn-sm" onclick="confirmTransactionSim(${tx.id})">Approve</button>` + actionBtnHtml;
                    }
                }

                card.innerHTML = `
                    <div class="tx-header">
                        <span class="tx-id-badge">TX #${tx.id}</span>
                        <span class="tx-status-badge ${statusClass}">${statusText}</span>
                    </div>
                    <div class="tx-details">
                        <div class="detail-item">
                            <span class="detail-label">Recipient (To)</span>
                            <span class="detail-val address" title="${tx.to}">${tx.to}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">USDC Transfer</span>
                            <span class="detail-val">${formatUSDC(tx.erc20Amount)} USDC</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Native Eth</span>
                            <span class="detail-val">${tx.value} ETH</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Calldata Payload</span>
                            <span class="detail-val address">${tx.data}</span>
                        </div>
                    </div>
                    <div class="tx-confirmers">
                        <span class="confirmers-lbl">Approvals (${tx.confirmationCount}/${THRESHOLD}):</span>
                        <div class="confirmers-avatars">
                            ${avatarsHtml}
                        </div>
                    </div>
                    <div class="tx-actions">
                        ${timeLockHtml}
                        <div class="tx-action-btns">
                            ${actionBtnHtml}
                        </div>
                    </div>
                `;
                timeline.appendChild(card);
            });
        }
    }
}

// --- STEPPER VIEW RENDERER ---
function renderStep(stepNum) {
    const stage = STEPPER_STAGES[stepNum - 1];
    const descArea = document.getElementById('step-description-area');
    if (!descArea) return;

    // Set indicator classes
    document.querySelectorAll('.step-indicator').forEach(el => {
        const itemStep = parseInt(el.getAttribute('data-step'));
        el.className = "step-indicator";
        if (itemStep === stepNum) {
            el.classList.add('active');
        } else if (itemStep < stepNum) {
            el.classList.add('completed');
        }
    });

    // Update connecting lines
    const indicators = document.querySelectorAll('.step-indicator');
    const lines = document.querySelectorAll('.step-line');
    lines.forEach((line, index) => {
        line.className = "step-line";
        if (index < stepNum - 1) {
            line.classList.add('completed');
        }
    });

    // Output description block
    descArea.innerHTML = `
        <div class="step-desc-card">
            <div class="step-desc-left">
                <h3>${stage.title}</h3>
                <p class="step-narrative">${stage.narrative}</p>
                <div class="divider"></div>
                <label class="detail-label">Equivalent solidity code block:</label>
                <pre class="code-snippet-box"><code>${stage.snippet}</code></pre>
            </div>
            <div class="step-desc-right">
                <div class="step-metric-box">
                    <h4>EVM Gas Consumption</h4>
                    <p class="gas-cost">${stage.gas}</p>
                </div>
                <div class="step-metric-box">
                    <h4>Cryptographic Assert Rule</h4>
                    <p class="validation-rule">${stage.rule}</p>
                </div>
                <div class="step-metric-box" style="border-color: rgba(124, 77, 255, 0.15)">
                    <h4>Security Impact</h4>
                    <p style="color: #d8b4fe; font-size: 0.85rem;">Validates access limits and consensus quorum states securely inside the blockchain virtual environment before modifying account storage slots.</p>
                </div>
            </div>
        </div>
    `;
}

// --- CODE VIEWER LOADER ---
function loadSolidityFile(filename) {
    const codeBox = document.getElementById('solidity-code-box');
    const label = document.getElementById('selected-file-label');
    if (!codeBox) return;

    const code = CODEBASE[filename];
    codeBox.textContent = code;
    label.textContent = filename;
}

// --- TAB SWITCHER LOGIC ---
function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

    const activeBtn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
    const activeContent = document.getElementById(`tab-${tabId}`);
    
    if (activeBtn && activeContent) {
        activeBtn.classList.add('active');
        activeContent.classList.add('active');
        
        logToConsole(`[SPA Route] Switched view to tab: <strong>${tabId.toUpperCase()}</strong>`, 'info');
        
        // Trigger specific tab renders if needed
        if (tabId === 'stepper') {
            renderStep(1);
        } else if (tabId === 'contracts') {
            const currentSelected = document.getElementById('contract-selector').value;
            loadSolidityFile(currentSelected);
        }
    }
}

// --- SET UP OWNERS MAP ---
const OWNERS = [
    { name: "Owner 1 (Proposer)", address: "0x1111111111111111111111111111111111111d33", avatar: "O1" },
    { name: "Owner 2", address: "0x2222222222222222222222222222222222222e44", avatar: "O2" },
    { name: "Owner 3", address: "0x3333333333333333333333333333333333333f55", avatar: "O3" }
];

// --- SETUP EVENT CONTROLLERS ---
document.addEventListener("DOMContentLoaded", () => {
    // 1. SPA Tabs navigation
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-tab');
            switchTab(targetTab);
        });
    });

    // 2. Owner selections (Prank Active Owner)
    const ownerSelector = document.getElementById('owner-selector');
    if (ownerSelector) {
        ownerSelector.addEventListener('click', (e) => {
            const option = e.target.closest('.owner-option');
            if (!option) return;
            
            document.querySelectorAll('.owner-option').forEach(el => el.classList.remove('active'));
            option.classList.add('active');

            activeOwnerIdx = parseInt(option.getAttribute('data-owner-idx'));
            logToConsole(`[Active Wallet] Switched active owner to <strong>${getActiveOwner().name}</strong> (${getActiveOwner().address.slice(0, 12)}...)`, 'info');
            updateUI();
        });
    }

    // 3. Propose transaction
    const proposeForm = document.getElementById('propose-form');
    if (proposeForm) {
        proposeForm.addEventListener('submit', (e) => {
            e.preventDefault();
            
            const to = document.getElementById('tx-recipient').value.trim();
            const erc20Amount = parseFloat(document.getElementById('tx-erc20').value) || 0;
            const valueEth = parseFloat(document.getElementById('tx-eth').value) || 0;
            const data = document.getElementById('tx-data').value.trim() || "0x";

            const success = proposeTransactionSim(to, valueEth, erc20Amount, data);
            if (success) {
                document.getElementById('tx-eth').value = 0;
            }
        });
    }

    // 4. Stepper Click Nodes
    const stepperTimeline = document.getElementById('visual-stepper');
    if (stepperTimeline) {
        stepperTimeline.addEventListener('click', (e) => {
            const indicator = e.target.closest('.step-indicator');
            if (!indicator) return;
            const selectedStep = parseInt(indicator.getAttribute('data-step'));
            renderStep(selectedStep);
        });
    }

    // 5. Contracts source selector
    const contractSelector = document.getElementById('contract-selector');
    if (contractSelector) {
        contractSelector.addEventListener('change', (e) => {
            loadSolidityFile(e.target.value);
        });
    }

    // 6. Copy code functionality
    const btnCopy = document.getElementById('btn-copy-code');
    if (btnCopy) {
        btnCopy.addEventListener('click', () => {
            const codeContent = document.getElementById('solidity-code-box').textContent;
            navigator.clipboard.writeText(codeContent).then(() => {
                btnCopy.textContent = "Copied!";
                btnCopy.classList.add('glow-animation');
                setTimeout(() => {
                    btnCopy.textContent = "Copy File Content";
                    btnCopy.classList.remove('glow-animation');
                }, 2000);
                logToConsole(`[VM System] Copied contract file content to clipboard.`, 'success');
            }).catch(err => {
                logToConsole(`[VM System Error] Clipboard write blocked: ${err}`, 'error');
            });
        });
    }

    // 7. General actions
    document.getElementById('btn-deposit-idle').addEventListener('click', depositIdleFundsSim);
    document.getElementById('btn-faucet').addEventListener('click', faucetUSDC);
    document.getElementById('btn-accrue').addEventListener('click', accrueYield);
    document.getElementById('btn-clear-logs').addEventListener('click', () => {
        document.getElementById('terminal-logs').innerHTML = "";
        logToConsole("Console cleared. EVM sandbox restarted.", 'info');
    });

    // 8. Bootstrap App
    logToConsole("Aetheris Custom Web3 SPA Sandbox Initialized Successfully.", 'success');
    logToConsole(`Governance structure: 2-of-3 Multi-Signature. Lead Architect: <strong>Mohammed Irfaan</strong>.`, 'info');
    OWNERS.forEach((o, idx) => logToConsole(`  Owner ${idx+1}: ${o.address}`, 'info'));
    
    updateUI();

    // Auto-update timer loop
    setInterval(() => {
        updateUI();
    }, 10000);
});

// Expose simulation methods globally for index.html integration
window.confirmTransactionSim = confirmTransactionSim;
window.revokeConfirmationSim = revokeConfirmationSim;
window.executeTransactionSim = executeTransactionSim;
window.timeWarpSim = timeWarpSim;
window.depositIdleFundsSim = depositIdleFundsSim;
window.accrueYield = accrueYield;
window.faucetUSDC = faucetUSDC;
