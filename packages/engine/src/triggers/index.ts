import { Registry, type TriggerType } from "@ignitra/core";
import type { AnyTriggerModule, TriggerModuleRegistry } from "../types";
import { balanceThresholdTrigger } from "./balance-threshold";
import { contractDeployedTrigger } from "./contract-deployed";
import { contractEventTrigger } from "./contract-event";
import { inboundWebhookTrigger } from "./inbound-webhook";
import { createNewHolderTrigger } from "./new-holder";
import { newLaunchTrigger } from "./new-launch";
import { vigilAlertTrigger } from "./vigil-alert";
import { scheduleTrigger } from "./schedule";
import { stateChangeTrigger } from "./state-change";
import { tokenTransferTrigger } from "./token-transfer";

/** Chain triggers (Phase 3), plus SCHEDULE / STATE_CHANGE / INBOUND_WEBHOOK (Phase 5). Phase 8: NEW_LAUNCH (launchpads) and VIGIL_ALERT. */
export function createTriggerModules(): TriggerModuleRegistry {
  const registry = new Registry<TriggerType, AnyTriggerModule>("trigger");
  registry.register(tokenTransferTrigger);
  registry.register(contractEventTrigger);
  registry.register(createNewHolderTrigger()); // stateful: one instance per process
  registry.register(balanceThresholdTrigger);
  registry.register(contractDeployedTrigger);
  registry.register(stateChangeTrigger);
  registry.register(scheduleTrigger);
  registry.register(inboundWebhookTrigger);
  registry.register(newLaunchTrigger);
  registry.register(vigilAlertTrigger);
  return registry;
}

export * from "./balance-threshold";
export * from "./contract-deployed";
export * from "./contract-event";
export * from "./erc20";
export * from "./inbound-webhook";
export * from "./new-holder";
export * from "./new-launch";
export * from "./vigil-alert";
export * from "./schedule";
export * from "./state-change";
export * from "./token-transfer";
