import { getContractAddress, keccak256, parseAbi, toHex } from "viem";
import type { NormalizedAddress } from "@ignitra/core";
import { SESSION_BOUNDS_INITCODE } from "./bounds-initcode";

/**
 * Contracts ONCHAIN_TX builds on. All are canonical, deterministic deployments that exist on
 * Robinhood Chain (checked with eth_getCode on 2026-11-07); the Roles mastercopy's runtime code
 * is byte-identical to the copy verified on Ethereum (Zodiac Roles v2.0, solc 0.8.21).
 */
export const ONCHAIN = {
  rolesMastercopy: "0x9646fdad06d3e24444381f44362a3b0eb343d337" as NormalizedAddress,
  moduleProxyFactory: "0x000000000000addb49795b0f9ba5bc298cdda236" as NormalizedAddress,
  /** Safe 1.4.1 MultiSendCallOnly: batches CALLs only (never a delegatecall inside the batch). */
  multiSendCallOnly: "0x9641d764fc13c8b624c04430c7356c1c7c8102e2" as NormalizedAddress,
  /** Arachnid's deterministic deployment proxy (CREATE2 with salt ‖ initcode). */
  create2Deployer: "0x4e59b44847b379578588920ca78fbf26c0b4956c" as NormalizedAddress,
} as const;

export const SESSION_BOUNDS_SALT = keccak256(toHex("ignitra:session-bounds:v1"));
/** IgnitraSessionBounds, wherever the CREATE2 deployer exists. */
export const SESSION_BOUNDS_ADDRESS = getContractAddress({
  opcode: "CREATE2",
  from: ONCHAIN.create2Deployer,
  salt: SESSION_BOUNDS_SALT,
  bytecode: SESSION_BOUNDS_INITCODE,
}).toLowerCase() as NormalizedAddress;

export { SESSION_BOUNDS_INITCODE };

/** Zodiac Roles v2 (subset of the verified ABI; events carry no indexed fields). */
export const ROLES_ABI = parseAbi([
  "function setUp(bytes initParams)",
  "function owner() view returns (address)",
  "function avatar() view returns (address)",
  "function target() view returns (address)",
  "function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)",
  "function scopeTarget(bytes32 roleKey, address targetAddress)",
  "function scopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, (uint8 parent, uint8 paramType, uint8 operator, bytes compValue)[] conditions, uint8 options)",
  "function setAllowance(bytes32 key, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp)",
  "function allowances(bytes32 key) view returns (uint128 refill, uint128 maxRefill, uint64 period, uint128 balance, uint64 timestamp)",
  "function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool success)",
  "event AssignRoles(address module, bytes32[] roleKeys, bool[] memberOf)",
  "event ScopeTarget(bytes32 roleKey, address targetAddress)",
  "event ScopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, (uint8 parent, uint8 paramType, uint8 operator, bytes compValue)[] conditions, uint8 options)",
  "event SetAllowance(bytes32 allowanceKey, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp)",
  "event AllowTarget(bytes32 roleKey, address targetAddress, uint8 options)",
  "event AllowFunction(bytes32 roleKey, address targetAddress, bytes4 selector, uint8 options)",
  "event RevokeTarget(bytes32 roleKey, address targetAddress)",
  "event RevokeFunction(bytes32 roleKey, address targetAddress, bytes4 selector)",
  "event SetDefaultRole(address module, bytes32 defaultRoleKey)",
  "error ConditionViolation(uint8 status, bytes32 info)",
  "error NotAuthorized(address module)",
  "error NoMembership()",
  "error ModuleTransactionFailed()",
  "error FunctionSignatureTooShort()",
  "error CalldataOutOfBounds()",
]);

export const SAFE_ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function isModuleEnabled(address module) view returns (bool)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
  "function enableModule(address module)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
  "event EnabledModule(address indexed module)",
  "event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash, uint256 payment)",
]);

export const MODULE_PROXY_FACTORY_ABI = parseAbi(["function deployModule(address masterCopy, bytes initializer, uint256 saltNonce) returns (address proxy)"]);
export const MULTISEND_ABI = parseAbi(["function multiSend(bytes transactions) payable"]);

/** Roles v2 `PermissionChecker.Status`, for reasons a call was refused. */
export const ROLES_STATUS = [
  "Ok",
  "DelegateCallNotAllowed",
  "TargetAddressNotAllowed",
  "FunctionNotAllowed",
  "SendNotAllowed",
  "OrViolation",
  "NorViolation",
  "ParameterNotAllowed",
  "ParameterLessThanAllowed",
  "ParameterGreaterThanAllowed",
  "ParameterNotAMatch",
  "NotEveryArrayElementPasses",
  "NoArrayElementPasses",
  "ParameterNotSubsetOfAllowed",
  "BitmaskOverflow",
  "BitmaskNotAllowed",
  "CustomConditionViolation",
  "AllowanceExceeded",
  "CallAllowanceExceeded",
  "EtherAllowanceExceeded",
] as const;

/** What each refusal means to the user. */
export const ROLES_STATUS_TEXT: Readonly<Record<string, string>> = {
  TargetAddressNotAllowed: "this contract is not in the grant",
  FunctionNotAllowed: "this function is not in the grant",
  SendNotAllowed: "the grant allows no ETH to be sent",
  DelegateCallNotAllowed: "delegatecalls are never allowed",
  ParameterGreaterThanAllowed: "the amount is above the grant's per-transaction limit",
  AllowanceExceeded: "the grant's daily token limit is used up",
  EtherAllowanceExceeded: "the grant's daily ETH limit is used up",
  CustomConditionViolation: "the grant has expired or the ETH value is above its per-transaction limit",
};
