/**
 * Prints final state hashes for a fixed set of reference matches (used by the cross-engine e2e test).
 *   npx tsx cli/hashes.ts
 */
import { crossEngineHashes } from '../src/bench/crosscheck';

console.log(JSON.stringify(crossEngineHashes()));
