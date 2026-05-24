# Aetheris: Automated Multi-Signature Treasury & Yield Router
### Production-Grade Custodial Security with Capital Efficiency
**Engineered and Developed by Mohammed Irfaan**
*Principal Web3 Architect & Senior Solidity Security Engineer*

---

Aetheris is an enterprise-grade, highly secure, and gas-optimized smart contract suite and interactive DApp dashboard that manages bulk digital assets. It features an automated **M-of-N consensus protocol**, immutable **Time-Lock delay enforcement** for high-value transactions, and **automated yield routing** to route surplus treasury capital into an ERC-4626 Tokenized Yield Vault (like Aave or Yearn) while routing deficit withdrawals in the same transaction call.

```
                  ┌──────────────────────────────────────────────┐
                  │                 OWNER QUORUM                 │
                  └──────────────┬───────────────────────────────┘
                                 │
                        Confirmations (M-of-N)
                                 │
                                 ▼
                  ┌──────────────────────────────────────────────┐
                  │              Aetheris Treasury               │
                  └──────────────┬──────────────▲────────────────┘
                                 │              │
                   Deposit Idle  │              │ Deficit Withdraw
                   (Surplus USDC)│              │ (USDC Settlement)
                                 ▼              │
                  ┌─────────────────────────────┴────────────────┐
                  │              ERC-4626 Yield Vault            │
                  └──────────────────────────────────────────────┘
```

---

## 🛡️ Core Security Architecture & Mathematical Invariants

### 1. Quorum Consent Integrity
* **Invariant**: `confirmations >= threshold`
* Safe-guards treasury holdings from single-point-of-failure vulnerabilities. A compromised key or stolen operational device cannot drain assets; execution strictly requires consensus approvals.

### 2. Time-Lock Delay Guard (Cooldown Protocol)
* **Invariant**: `block.timestamp >= timeLockStart + timeLockDelay` (triggers above `10,000 USDC` or `10 ETH`)
* Mitigates private key takeover risks. If a quorum is compromised and a hostile transaction is proposed, remaining owners have a mandatory 2-day period to review the queue, revoke confirmations, and permanently disable the proposal.

### 3. Idle Capital Efficiency (Vault Separation)
* **Invariant**: `internalBalance <= maxIdleThreshold` (Surplus is routed to Yield Vault)
* Keeps bulk treasury capital secured and interest-bearing inside a tokenized ERC-4626 vault. The local liquid capital of the treasury is capped at exactly `5,000 USDC` to limit hot-wallet exposure.

### 4. Dynamic Deficit Routing
* During transaction execution, if the liquid treasury balance cannot settle the transfer, the contract calculates the deficit, withdraws it from the ERC-4626 vault, burns the shares, and completes the transfer in a *single synchronous transaction block*, ensuring zero manual management overhead.

---

## 📂 Repository File Structure

* **`src/IMockVault.sol`**: Standard ERC-4626 interface detail representing external yield protocols.
* **`src/MultiSigTreasury.sol`**: Main custody logic featuring reentrancy blocks, constructor security checks, custom errors, and event triggers.
* **`test/MultiSigTreasury.t.sol`**: Comprehensive Foundry test suite containing unit, integration, and fuzz tests.
* **`dashboard/index.html`**: Premium dark glassmorphic portal with custom tabs.
* **`dashboard/style.css`**: CSS variables, responsive design, custom timeline animations, and syntax styling.
* **`dashboard/app.js`**: EVM virtual sandbox state machine, 5-stage stepper router, and code-copy actions.

---

## 🛠️ Developer Deployment & Local Compilation

Aetheris is fully Forge-compliant and ready to build.

### Prerequisite: Install Foundry
```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

### Compile Smart Contracts
```bash
forge build
```

### Execute Tests & Gas Audit
```bash
forge test -vvv --gas-report
```

---

## 🌐 Launching the Interactive DApp Dashboard

Aetheris includes a complete, high-fidelity Web3 Single Page Application (SPA) that acts as an EVM client and simulator. 

### How to Open the DApp Locally
Double-click the HTML file or paste the absolute path below into your favorite browser search bar to play with the sandbox, security audit, stepper, and IDE code views instantly:
```text
file:///c:/Users/leona/OneDrive/Documents/multisig-treasury/dashboard/index.html
```

### Simulator Features:
* **Prank Owners**: Toggle active owners to confirm or revoke approvals.
* **depositIdleFunds()**: Run surplus routing to see USDC move to the vault, then click **"Accrue 5% Yield"** to watch interest multiply.
* **Time-Warp simulation**: warp state time-locks forward by 2 days (`vm.warp`) to trigger executions.
* **Console Logs**: Scroll through live Event and EVM call traces.

---

## 📝 License & Author Profile

Developed with cryptographic rigor and Web3 design standards by **Mohammed Irfaan**.
Released under the **MIT License**.
