import { MAX_SYMBOL_DICTIONARY_SIZE } from "./constants";

/**
 * Global symbol dictionary shared by all tables of a sender.
 *
 * IDs are allocated sequentially from 0. Each message carries only the delta
 * of new entries since the last confirmed baseline (see QwpEncoder).
 */
export class GlobalSymbolDictionary {
  private readonly symbolToId = new Map<string, number>();
  private readonly idToSymbol: string[] = [];
  private nextId = 0;

  /**
   * Returns the global ID for the given symbol, registering it if new.
   * @throws Error if the dictionary is full
   */
  getOrAddSymbol(symbol: string): number {
    const existing = this.symbolToId.get(symbol);
    if (existing !== undefined) {
      return existing;
    }
    if (this.nextId >= MAX_SYMBOL_DICTIONARY_SIZE) {
      throw new Error(
        `Global symbol dictionary is full, max size is ${MAX_SYMBOL_DICTIONARY_SIZE}`,
      );
    }
    const id = this.nextId++;
    this.symbolToId.set(symbol, id);
    this.idToSymbol[id] = symbol;
    return id;
  }

  /** Returns the symbol string for a global ID, or undefined. */
  getSymbol(id: number): string | undefined {
    return this.idToSymbol[id];
  }

  /** Highest allocated global ID, or -1 when the dictionary is empty. */
  getMaxId(): number {
    return this.nextId - 1;
  }

  get size(): number {
    return this.nextId;
  }
}
