/**
 * Per-conversation model / reasoning-effort selection.
 *
 * Resolution order (first match wins):
 *   runtime override (from `/model` / `/effort` commands)
 *   > `model.map[conversationKey]` (or bare id)
 *   > `model.default` preset
 *   > dsh `agentDefaultModel.currentSelection()`
 *
 * Unlike the workspace (cwd), the model selection is session-LIVE: applying a
 * new selection to an existing agent takes effect on its next request, so a
 * model switch does NOT reset the conversation context.
 */

import type { WildfireConfig, WildfireModelConfig } from "./config.js";
import { getModelConfig } from "./config.js";

/** Effective model settings (default preset id stays optional). */
type EffectiveModelConfig = Required<Omit<WildfireModelConfig, "default">> & {
  default?: string;
};

/** A dsh ModelSelection: provider/model plus an optional reasoning effort. */
export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** One entry of the DSH runtime model catalog (`ctx.llm`). */
export interface ModelCatalogEntry {
  provider: string;
  id: string;
  name: string;
}

export class ModelSelector {
  private config: EffectiveModelConfig;
  private ctx: any;
  private logger: any;
  private overrides = new Map<string, ModelSelection>();

  constructor(config: WildfireConfig, ctx: any, logger?: any) {
    this.config = getModelConfig(config);
    this.ctx = ctx;
    this.logger = logger;
  }

  /** Resolve the effective selection for a conversation key. */
  async resolve(key: string): Promise<ModelSelection> {
    const override = this.overrides.get(key);
    if (override) return { ...override };

    const mappedId = this.mapLookup(key);
    if (mappedId) {
      const preset = this.config.allowed[mappedId];
      if (preset) return { ...preset };
      this.logger?.warn?.(
        `[wildfire-model] map of ${key} points to unknown preset "${mappedId}", falling back`
      );
    }

    if (this.config.default) {
      const preset = this.config.allowed[this.config.default];
      if (preset) return { ...preset };
      this.logger?.warn?.(
        `[wildfire-model] default preset "${this.config.default}" not found in allowed`
      );
    }

    const current = this.ctx?.get?.("agentDefaultModel")?.currentSelection?.();
    if (current?.provider && current?.model) {
      return {
        provider: current.provider,
        model: current.model,
        reasoningEffort: current.reasoningEffort,
      };
    }
    throw new Error(
      "no model selection available: configure model.allowed / model.default or check the dsh agentDefaultModel"
    );
  }

  /** Alias for resolve(); used by `/model` queries. */
  async peek(key: string): Promise<ModelSelection> {
    return this.resolve(key);
  }

  /** Apply a preset by id as the conversation's runtime override. */
  applyPreset(key: string, presetId: string): ModelSelection | null {
    const preset = this.config.allowed[presetId];
    if (!preset) return null;
    const selection: ModelSelection = { ...preset };
    this.overrides.set(key, selection);
    this.logger?.info?.(
      `[wildfire-model] override: ${key} -> ${selection.provider}/${selection.model}${selection.reasoningEffort ? ` (effort=${selection.reasoningEffort})` : ""}`
    );
    return selection;
  }

  /**
   * Apply an explicit provider/model from the runtime catalog, KEEPING the
   * conversation's current reasoning effort (unlike applyPreset, which adopts
   * the preset's effort). Used by `/model <provider/model|id>`.
   */
  async applyModel(key: string, provider: string, modelId: string): Promise<ModelSelection> {
    const current = await this.resolve(key);
    const selection: ModelSelection = { ...current, provider, model: modelId };
    this.setOverride(key, selection);
    return selection;
  }

  /**
   * Aggregate the DSH runtime model catalog (`ctx.llm`): every registered
   * provider's advertised models — the same source as the web UI model
   * selector. Returns [] when the llm service is unavailable; a provider
   * whose listing fails is skipped with a warning.
   */
  async listCatalog(): Promise<ModelCatalogEntry[]> {
    let llm: any;
    try {
      llm = this.ctx?.get?.("llm");
    } catch {
      llm = undefined;
    }
    if (!llm) return [];
    const entries: ModelCatalogEntry[] = [];
    for (const provider of llm.listProviders?.() ?? []) {
      try {
        const models = (await llm.listModels(provider.id)) ?? [];
        for (const model of models) {
          entries.push({ provider: String(provider.id), id: String(model.id), name: String(model.name ?? model.id) });
        }
      } catch (err: any) {
        this.logger?.warn?.(`[wildfire-model] listModels(${provider.id}) failed: ${err?.message ?? String(err)}`);
      }
    }
    return entries;
  }

  /** Apply a selection directly (used by `/effort` to keep the current model). */
  setOverride(key: string, selection: ModelSelection): void {
    this.overrides.set(key, { ...selection });
    this.logger?.info?.(
      `[wildfire-model] override: ${key} -> ${selection.provider}/${selection.model}${selection.reasoningEffort ? ` (effort=${selection.reasoningEffort})` : ""}`
    );
  }

  /** Clear the runtime override for a conversation. */
  clearOverride(key: string): void {
    this.overrides.delete(key);
  }

  /** Human-readable preset list for `/model` replies. */
  listPresets(): string[] {
    const names = Object.keys(this.config.allowed);
    if (names.length === 0) return [];
    return names.map((id) => {
      const p = this.config.allowed[id];
      const effort = p.reasoningEffort ? ` / effort=${p.reasoningEffort}` : "";
      return `${id}: ${p.provider}/${p.model}${effort}`;
    });
  }

  /** Map lookup supporting both the full key and the bare id after the prefix. */
  private mapLookup(key: string): string | undefined {
    if (this.config.map[key]) return this.config.map[key];
    const stripped = key.replace(/^wildfire:(user|group):/i, "");
    if (stripped !== key && this.config.map[stripped]) return this.config.map[stripped];
    return undefined;
  }
}
