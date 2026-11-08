// SPDX-License-Identifier: MIT
pragma solidity 0.8.21;

/// @title IgnitraSessionBounds
/// @notice A custom condition for Zodiac Roles v2 (`Operator.Custom`). A scoped call passes while
///         `block.timestamp` is at or before the grant's expiry and the ETH it sends is at most the
///         grant's per-transaction cap. Roles v2 has no expiry and cannot cap `msg.value` per call
///         on its own; everything else (targets, functions, daily ETH and token allowances) is
///         enforced by Roles itself.
/// @dev `extra` (the 12 bytes Roles passes from the condition's compValue) packs
///         expiry (uint32, unix seconds) ‖ maxValuePerTx (uint64, in gwei).
///      Stateless and ownerless: it holds nothing and nobody can change it. Deployed
///      deterministically through the CREATE2 deployer 0x4e59b44847b379578588920cA78FbF26c0B4956C.
contract IgnitraSessionBounds {
    /// @param value The ETH sent with the scoped call.
    /// @param extra expiry (uint32) ‖ maxValuePerTx in gwei (uint64).
    function check(
        address, /* to */
        uint256 value,
        bytes calldata, /* data */
        uint8, /* operation */
        uint256, /* location */
        uint256, /* size */
        bytes12 extra
    ) external view returns (bool success, bytes32 reason) {
        uint256 packed = uint96(extra);
        uint256 expiry = packed >> 64;
        uint256 maxValue = uint256(uint64(packed)) * 1 gwei;
        if (block.timestamp > expiry) return (false, bytes32("session expired"));
        if (value > maxValue) return (false, bytes32("value above per-tx cap"));
        return (true, bytes32(0));
    }
}
