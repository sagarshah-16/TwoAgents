import type { BridgeApi } from "./shared/types";

declare global {
  interface Window {
    twoAgents: BridgeApi;
  }
}

export {};
