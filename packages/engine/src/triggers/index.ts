import { Registry, type TriggerType } from "@ignitra/core";
import type { AnyTriggerModule, TriggerModuleRegistry } from "../types";
import { balanceThresholdTrigger } from "./balance-threshold";
import { contractDeployedTrigger } from "./contract-deployed";
import { contractEventTrigger } from "./contract-event";
import { createNewHolderTrigger } from "./new-holder";
import { tokenTransferTrigger } from "./token-transfer";

/** Chain triggers of Phase 3. SCHEDULE / STATE_CHANGE / INBOUND_WEBHOOK arrive in Phase 5, VIGIL_ALERT in Phase 8. */
export function createTriggerModules(): TriggerModuleRegistry {
  const registry = new Registry<TriggerType, AnyTriggerModule>("trigger");
  registry.register(tokenTransferTrigger);
  registry.register(contractEventTrigger);
  registry.register(createNewHolderTrigger()); // stateful: one instance per process
  registry.register(balanceThresholdTrigger);
  registry.register(contractDeployedTrigger);
  return registry;
}

export * from "./balance-threshold";
export * from "./contract-deployed";
export * from "./contract-event";
export * from "./erc20";
export * from "./new-holder";
export * from "./token-transfer";
