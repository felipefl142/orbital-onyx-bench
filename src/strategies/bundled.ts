import type { GenerationRecord } from '../llm/generate';

/**
 * Strategies in the repository's `strategies/` folder (written by `npm run generate` or by hand), bundled into the
 * app at build time so they show up in the Arena and the Model Lab without importing. Browser/Vite only.
 */
const code = import.meta.glob('../../strategies/*.js', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const gens = import.meta.glob('../../strategies/*.gen.json', { import: 'default', eager: true }) as Record<string, GenerationRecord>;

export interface BundledStrategy {
  file: string;
  code: string;
  generation: GenerationRecord | null;
}

export const BUNDLED_STRATEGIES: BundledStrategy[] = Object.entries(code)
  .filter(([path]) => !path.endsWith('.failed.js'))
  .map(([path, src]) => {
    const file = path.split('/').pop()!.replace(/\.js$/, '');
    return { file, code: src, generation: gens[path.replace(/\.js$/, '.gen.json')] ?? null };
  })
  .sort((a, b) => a.file.localeCompare(b.file));
