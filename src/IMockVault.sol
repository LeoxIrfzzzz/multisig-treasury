// SPDX-License-Identifier: MIT
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
     * @notice Returns the address of the underlying token used for the vault for accounting, depositing, and withdrawing.
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
}
