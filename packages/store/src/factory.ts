import type { Store } from "./store.js";
import { MockFileStore } from "./mock-store.js";
import { SupabaseStore } from "./supabase-store.js";

export type DataProvider = "supabase" | "mock";

export interface StoreFactoryOptions {
  provider?: DataProvider;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  mockStorePath?: string;
  seed?: Parameters<Store["seedIfEmpty"]>[0];
}

/**
 * Creates the configured store. The mock provider keeps automated tests
 * deterministic; supabase is the production provider.
 */
export function createStore(options: StoreFactoryOptions = {}): Store {
  const provider = options.provider ?? process.env.DATA_PROVIDER ?? "mock";
  if (provider === "supabase") {
    const url = options.supabaseUrl ?? process.env.SUPABASE_URL;
    const key = options.supabaseServiceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "DATA_PROVIDER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
      );
    }
    return new SupabaseStore({ url, serviceRoleKey: key });
  }
  return new MockFileStore({
    filePath: options.mockStorePath ?? process.env.MOCK_STORE_PATH ?? "./data/mock-store.json",
    seed: options.seed,
  });
}
