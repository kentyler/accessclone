/**
 * Registry for on-disk handler files.
 * Discovers handler modules via import.meta.glob (eager — handlers are small data).
 */

import type { HandlerEntry } from '@/api/types';

interface HandlerModule {
  handlers: Record<string, HandlerEntry>;
}

const modules = import.meta.glob<HandlerModule>(
  './handlers/**/*.ts',
  { eager: true }
);

// Build registry keyed by "databaseId/ModuleName"
const registry: Record<string, Record<string, HandlerEntry>> = {};

for (const [path, mod] of Object.entries(modules)) {
  // Path looks like: ./handlers/northwind4/Form_frmAbout.ts
  const match = path.match(/\.\/handlers\/([^/]+)\/([^/]+)\.ts$/);
  if (match && mod.handlers) {
    const key = `${match[1]}/${match[2]}`;
    registry[key] = mod.handlers;
  }
}

/**
 * Register all fn.* handlers for a database with the AC runtime.
 * Called when the database changes so cross-module function dispatch works.
 */
export function registerFnHandlers(databaseId: string): number {
  const AC = (window as unknown as Record<string, Record<string, (name: string, js: string) => void>>).AC;
  if (!AC?.registerFnHandler) return 0;

  let count = 0;
  const prefix = `${databaseId}/`;
  const prefixLower = prefix.toLowerCase();

  for (const [key, handlers] of Object.entries(registry)) {
    if (!key.startsWith(prefix) && !key.toLowerCase().startsWith(prefixLower)) continue;
    for (const [hKey, handler] of Object.entries(handlers)) {
      if (hKey.startsWith('fn.') && handler.js) {
        const fnName = hKey.substring(3);
        AC.registerFnHandler(fnName, handler.js);
        count++;
      }
    }
  }
  return count;
}

/**
 * Look up handlers from on-disk files.
 * Returns null if no file exists for this module.
 */
export function getFileHandlers(databaseId: string, moduleName: string): Record<string, HandlerEntry> | null {
  // Exact match first
  const key = `${databaseId}/${moduleName}`;
  if (registry[key]) return registry[key];

  // Case-insensitive fallback
  const keyLower = key.toLowerCase();
  for (const k of Object.keys(registry)) {
    if (k.toLowerCase() === keyLower) return registry[k];
  }

  return null;
}
