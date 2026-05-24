// SPDX-License-Identifier: MIT
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
        if (!isOwner[msg.sender]) {
            revert MultiSig__NotOwner();
        }
        _;
    }

    modifier txExists(uint256 _txId) {
        if (_txId >= transactions.length) {
            revert MultiSig__TxDoesNotExist();
        }
        _;
    }

    modifier notExecuted(uint256 _txId) {
        if (transactions[_txId].executed) {
            revert MultiSig__TxAlreadyExecuted();
        }
        _;
    }

    modifier notConfirmed(uint256 _txId, address _owner) {
        if (confirmations[_txId][_owner]) {
            revert MultiSig__TxAlreadyConfirmed();
        }
        _;
    }

    modifier confirmed(uint256 _txId, address _owner) {
        if (!confirmations[_txId][_owner]) {
            revert MultiSig__TxNotConfirmed();
        }
        _;
    }

    // --- CONSTRUCTOR ---

    /**
     * @notice Initializes the multi-sig treasury with owners, threshold, and yield integration parameters.
     * @param _owners Array of initial owners (must contain no duplicates and no zero addresses).
     * @param _threshold Required number of confirmations for execution.
     * @param _timeLockDelay Duration (in seconds) that large transactions must wait after reaching threshold.
     * @param _timeLockThresholdEth Amount of native Ether (in wei) above which time-lock is triggered.
     * @param _timeLockThresholdErc20 Amount of ERC-20 tokens above which time-lock is triggered.
     * @param _erc20Token Address of the primary managed ERC-20 token (e.g., USDC).
     * @param _yieldVault Address of the ERC-4626 Vault managing the yield strategies for _erc20Token.
     * @param _maxIdleThreshold Target liquid amount of ERC-20 to retain in the treasury before yield routing.
     */
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
        if (_owners.length == 0) {
            revert MultiSig__InvalidOwnersLength();
        }
        if (_threshold == 0 || _threshold > _owners.length) {
            revert MultiSig__InvalidThreshold();
        }
        if (_erc20Token == address(0) || _yieldVault == address(0)) {
            revert MultiSig__ZeroAddress();
        }
        if (IMockVault(_yieldVault).asset() != _erc20Token) {
            revert MultiSig__AssetMismatch();
        }

        // Save owners and initialize mappings
        uint256 numOwners = _owners.length;
        for (uint256 i = 0; i < numOwners; ++i) {
            address owner = _owners[i];
            if (owner == address(0)) {
                revert MultiSig__ZeroAddress();
            }
            if (isOwner[owner]) {
                revert MultiSig__OwnerNotUnique();
            }
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

    // --- EXTERNAL/PUBLIC GOVERNANCE FUNCTIONS ---

    /**
     * @notice Proposes a new multi-sig transaction.
     * @dev Automatically registers a confirmation for the proposer to optimize gas.
     * @param _to The recipient address of the transaction.
     * @param _value The amount of native Ether to send.
     * @param _data Transaction call payload for contract interaction.
     * @param _erc20Amount The amount of managed ERC-20 tokens to transfer.
     * @return txId The index of the newly created transaction.
     */
    function proposeTransaction(
        address _to,
        uint256 _value,
        bytes calldata _data,
        uint256 _erc20Amount
    ) external onlyOwner returns (uint256 txId) {
        if (_to == address(0)) {
            revert MultiSig__ZeroAddress();
        }

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

        // If threshold is 1, immediately check and start the time-lock if applicable
        if (threshold == 1) {
            if (_value > timeLockThresholdEth || _erc20Amount > timeLockThresholdErc20) {
                transactions[txId].timeLockStart = block.timestamp;
                emit TimeLockStarted(txId, block.timestamp);
            }
        }
    }

    /**
     * @notice Confirms a proposed transaction.
     * @param _txId The transaction ID.
     */
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

        // Start time-lock if confirmation count meets threshold and threshold checks are active
        if (transaction.confirmationCount >= threshold && transaction.timeLockStart == 0) {
            if (transaction.value > timeLockThresholdEth || transaction.erc20Amount > timeLockThresholdErc20) {
                transaction.timeLockStart = block.timestamp;
                emit TimeLockStarted(_txId, block.timestamp);
            }
        }
    }

    /**
     * @notice Revokes a previously submitted confirmation.
     * @dev Resets the time-lock start timer if approval count falls below the threshold.
     * @param _txId The transaction ID.
     */
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

        // Reset time-lock if approvals drop below threshold
        if (transaction.confirmationCount < threshold && transaction.timeLockStart != 0) {
            transaction.timeLockStart = 0;
            emit TimeLockCancelled(_txId);
        }
    }

    /**
     * @notice Executes a confirmed multi-signature transaction.
     * @dev Routes idle capital efficiently, withdrawing from the ERC-4626 vault if internal balance is insufficient.
     * @param _txId The transaction ID.
     */
    function executeTransaction(uint256 _txId)
        external
        onlyOwner
        nonReentrant
        txExists(_txId)
        notExecuted(_txId)
    {
        Transaction storage transaction = transactions[_txId];

        if (transaction.confirmationCount < threshold) {
            revert MultiSig__ThresholdNotReached();
        }

        // Time-Lock Validation
        bool requiresTimeLock = (transaction.value > timeLockThresholdEth || transaction.erc20Amount > timeLockThresholdErc20);
        if (requiresTimeLock) {
            if (transaction.timeLockStart == 0) {
                revert MultiSig__TimeLockNotActive();
            }
            if (block.timestamp < transaction.timeLockStart + timeLockDelay) {
                revert MultiSig__TimeLockNotPassed();
            }
        }

        // Mark as executed first to prevent reentrancy (Checks-Effects-Interactions pattern)
        transaction.executed = true;

        // 1. Yield Routing / Deficit Settlement for ERC-20
        if (transaction.erc20Amount > 0) {
            uint256 internalBalance = erc20Token.balanceOf(address(this));
            if (internalBalance < transaction.erc20Amount) {
                uint256 deficit = transaction.erc20Amount - internalBalance;
                
                // Security check: Check vault capacity
                uint256 vaultShares = yieldVault.balanceOf(address(this));
                uint256 vaultAssets = yieldVault.convertToAssets(vaultShares);
                
                if (internalBalance + vaultAssets < transaction.erc20Amount) {
                    revert MultiSig__NotEnoughBalance();
                }

                // Execute synchronous withdrawal of the required deficit
                yieldVault.withdraw(deficit, address(this), address(this));
                emit YieldWithdrawn(deficit);
            }

            // Transfer the ERC-20 tokens to the recipient
            erc20Token.safeTransfer(transaction.to, transaction.erc20Amount);
        }

        // 2. Value Call / Payload Execution
        if (transaction.value > 0 || transaction.data.length > 0) {
            (bool success, bytes memory returnData) = transaction.to.call{value: transaction.value}(transaction.data);
            if (!success) {
                revert MultiSig__ExecutionFailed(returnData);
            }
        }

        emit TxExecuted(_txId, msg.sender);
    }

    // --- CAPITAL ROUTER / YIELD HOOKS ---

    /**
     * @notice Public utility function allowing any user to route surplus idle capital to the yield vault.
     * @dev Deposits the balance surplus above the `maxIdleThreshold` into the ERC-4626 vault.
     */
    function depositIdleFunds() external nonReentrant {
        uint256 balance = erc20Token.balanceOf(address(this));
        if (balance <= maxIdleThreshold) {
            revert MultiSig__NoIdleFundsToDeposit();
        }

        uint256 idleAmount = balance - maxIdleThreshold;

        // Reset vault approval (USDT compatibility) and then increase to target
        erc20Token.safeApprove(address(yieldVault), 0);
        erc20Token.safeApprove(address(yieldVault), idleAmount);

        // Mint shares by depositing underlying asset
        uint256 shares = yieldVault.deposit(idleAmount, address(this));
        if (shares == 0) {
            revert MultiSig__IdleDepositFailed();
        }

        emit YieldDeposited(idleAmount, shares);
    }

    // --- VIEW HELPERS ---

    /**
     * @notice Get all active owners of the MultiSig Treasury.
     * @return Array of owner addresses.
     */
    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    /**
     * @notice Get the total number of proposed transactions.
     * @return Count of transactions.
     */
    function getTransactionCount() external view returns (uint256) {
        return transactions.length;
    }

    /**
     * @notice Fetch a specific transaction's detail.
     */
    function getTransaction(uint256 _txId)
        external
        view
        txExists(_txId)
        returns (
            address to,
            uint256 value,
            bytes memory data,
            uint256 erc20Amount,
            bool executed,
            uint256 confirmationCount,
            uint256 timeLockStart
        )
    {
        Transaction storage transaction = transactions[_txId];
        return (
            transaction.to,
            transaction.value,
            transaction.data,
            transaction.erc20Amount,
            transaction.executed,
            transaction.confirmationCount,
            transaction.timeLockStart
        );
    }

    // --- RECEIVE & FALLBACK ---

    receive() external payable {}
    fallback() external payable {}
}
