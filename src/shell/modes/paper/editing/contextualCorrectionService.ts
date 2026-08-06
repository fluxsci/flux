import { fileBridge } from "../../../../lib/project/types";
import type {
  CorrectionAggressiveness,
  ContextCorrectionPacketV1,
  ContextCorrectionResultV1,
} from "./contextualCorrectionCore";

export type ContextualCorrectionProvider = "flux" | "ollama" | "openai";

export interface ContextualCorrectionProviderConfig {
  provider: ContextualCorrectionProvider;
  model: string;
  thinking?: boolean;
  aggressiveness?: CorrectionAggressiveness;
}

class ContextualCorrectionService {
  async warm(provider: ContextualCorrectionProvider, model: string): Promise<void> {
    const bridge = fileBridge();
    if (bridge?.correctionWarm) {
      await bridge.correctionWarm({ provider, model }).catch(() => false);
      return;
    }
    if (provider === "flux") await bridge?.correctionModelWarm?.().catch(() => false);
  }

  async status(provider: ContextualCorrectionProvider, model = "") {
    return await fileBridge()?.correctionStatus?.(provider, model) ?? {
      provider,
      available: false,
      error: "Contextual corrections require the Flux desktop app",
    };
  }

  async decide(
    packet: ContextCorrectionPacketV1,
    config: ContextualCorrectionProviderConfig,
  ): Promise<ContextCorrectionResultV1> {
    const decide = fileBridge()?.correctionDecide;
    if (!decide) throw new Error("Contextual correction provider is unavailable");
    return await decide({ packet, ...config }) as ContextCorrectionResultV1;
  }

  async cancel(requestId: string): Promise<void> {
    await fileBridge()?.correctionCancel?.(requestId).catch(() => false);
  }
}

export const contextualCorrectionService = new ContextualCorrectionService();
