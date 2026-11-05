import { parseAbi, type Abi } from "viem";

/**
 * Built-in ABIs, used when a contract's verified ABI is unknown. Several
 * events share a topic0 but differ in which params are indexed (ERC-20 vs
 * ERC-721 `Transfer`; Safe v1.3 vs v1.4 owner/module events). The decoder
 * tries every candidate for a topic0 and keeps the one that decodes strictly.
 */
export const BUILTIN_ABIS = {
  erc20: parseAbi([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "event Approval(address indexed owner, address indexed spender, uint256 value)",
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address account) view returns (uint256)",
  ]),
  erc721: parseAbi([
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
    "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
    "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
  ]),
  ownable: parseAbi([
    "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
    "event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)",
    "function owner() view returns (address)",
    "function pendingOwner() view returns (address)",
  ]),
  accessControl: parseAbi([
    "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
    "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
    "event RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
  ]),
  pausable: parseAbi([
    "event Paused(address account)",
    "event Unpaused(address account)",
    "function paused() view returns (bool)",
  ]),
  erc1967: parseAbi([
    "event Upgraded(address indexed implementation)",
    "event AdminChanged(address previousAdmin, address newAdmin)",
    "event BeaconUpgraded(address indexed beacon)",
  ]),
  safe: parseAbi([
    // v1.4.x indexes the address; v1.3.0 does not. Same topic0.
    "event AddedOwner(address indexed owner)",
    "event AddedOwner(address owner)",
    "event RemovedOwner(address indexed owner)",
    "event RemovedOwner(address owner)",
    "event EnabledModule(address indexed module)",
    "event EnabledModule(address module)",
    "event DisabledModule(address indexed module)",
    "event DisabledModule(address module)",
    "event ChangedGuard(address indexed guard)",
    "event ChangedGuard(address guard)",
    "event ChangedFallbackHandler(address indexed handler)",
    "event ChangedFallbackHandler(address handler)",
    "event ChangedThreshold(uint256 threshold)",
    "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
    "event ExecutionFailure(bytes32 txHash, uint256 payment)",
    "event ExecutionFromModuleSuccess(address indexed module)",
    "event ExecutionFromModuleFailure(address indexed module)",
    "event SafeReceived(address indexed sender, uint256 value)",
    "event SafeSetup(address indexed initiator, address[] owners, uint256 threshold, address initializer, address fallbackHandler)",
    "event ApproveHash(bytes32 indexed approvedHash, address indexed owner)",
    "event SignMsg(bytes32 indexed msgHash)",
  ]),
} as const satisfies Record<string, Abi>;

export type BuiltinAbiName = keyof typeof BUILTIN_ABIS;

/** keccak256("eip1967.proxy.implementation") - 1 */
export const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
