/**
 * One-way lockdown of the current realm. Call it only in a realm that runs the simulation and strategies and
 * nothing else: the match Web Worker, or the headless CLI after its imports are loaded. Never in the UI thread.
 *
 * It removes network and timing globals, closes the `fn.constructor('return this')()` escape hatch, and freezes the
 * shared intrinsics so one strategy cannot patch `Array.prototype` under another.
 *
 * This is a fairness boundary for a benchmark, not a security boundary against hostile code. Run strategies from
 * sources you are willing to execute.
 */
let hardened = false;

export function hardenRealm(): void {
  if (hardened) return;
  hardened = true;
  const g = globalThis as Record<string, unknown>;
  for (const name of [
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'importScripts',
    'indexedDB',
    'caches',
    'BroadcastChannel',
    'WebTransport',
    'Worker',
    'SharedWorker',
    'eval',
  ]) {
    try {
      Object.defineProperty(g, name, { value: undefined, writable: false, configurable: false });
    } catch {
      /* not present or not configurable */
    }
  }

  const ctorProtos = [
    Function.prototype,
    Object.getPrototypeOf(async function () {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function* () {}),
  ];
  for (const p of ctorProtos) {
    try {
      Object.defineProperty(p, 'constructor', { value: undefined, writable: false, configurable: false });
    } catch {
      /* ignore */
    }
  }

  for (const o of [
    Object.prototype,
    Array.prototype,
    Function.prototype,
    String.prototype,
    Number.prototype,
    Boolean.prototype,
    Map.prototype,
    Set.prototype,
    JSON,
    Math,
  ]) {
    Object.freeze(o);
  }
}
