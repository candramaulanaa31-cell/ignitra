// SPDX-License-Identifier: MIT
pragma solidity 0.8.21;

import {IgnitraSessionBounds} from "../src/IgnitraSessionBounds.sol";

interface Vm {
    function warp(uint256) external;
}

/// Boundaries of the custom condition, without forge-std (no dependencies to vendor).
contract IgnitraSessionBoundsTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    IgnitraSessionBounds bounds = new IgnitraSessionBounds();

    function pack(uint32 expiry, uint64 maxGwei) internal pure returns (bytes12) {
        return bytes12(uint96((uint96(expiry) << 64) | maxGwei));
    }

    function check(uint256 value, bytes12 extra) internal view returns (bool ok, bytes32 reason) {
        return bounds.check(address(0xBEEF), value, hex"", 0, 0, 0, extra);
    }

    function test_passesUntilTheLastSecondOfExpiry() public {
        vm.warp(1_000_000);
        (bool ok,) = check(0, pack(1_000_000, 0));
        require(ok, "at expiry");
        vm.warp(1_000_001);
        (bool late, bytes32 reason) = check(0, pack(1_000_000, 0));
        require(!late && reason == bytes32("session expired"), "after expiry");
    }

    function test_capsValuePerCallInGwei() public {
        vm.warp(1_000_000);
        bytes12 extra = pack(2_000_000, 100_000_000); // 0.1 ETH
        (bool atCap,) = check(0.1 ether, extra);
        require(atCap, "exactly the cap");
        (bool over, bytes32 reason) = check(0.1 ether + 1, extra);
        require(!over && reason == bytes32("value above per-tx cap"), "one wei over");
        (bool none,) = check(1, pack(2_000_000, 0));
        require(!none, "zero cap allows no ETH");
    }

    function test_maxPackedValuesDoNotOverflow() public {
        vm.warp(1_000_000);
        (bool ok,) = check(uint256(type(uint64).max) * 1 gwei, pack(type(uint32).max, type(uint64).max));
        require(ok, "max cap");
    }
}
