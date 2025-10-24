const DEFAULT_SEED = "sonicsuite";

export type Rng = () => number;

export function hashSeed(seed: string): number {
  let h1 = 0xdeadbeef ^ seed.length;
  let h2 = 0x41c6ce57 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 & 0xffff_ffff) >>> 0;
}

function mulberry32(seed: number): Rng {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed?: string | null): Rng {
  const value = seed && seed.trim().length > 0 ? seed.trim() : DEFAULT_SEED;
  return mulberry32(hashSeed(value));
}

export function nextInt(rng: Rng, min: number, max: number): number {
  if (max < min) {
    throw new Error(`Invalid range (${min}, ${max})`);
  }
  const span = max - min;
  if (span === 0) return min;
  return min + Math.floor(rng() * (span + 1));
}

export function nextFloat(rng: Rng, min = 0, max = 1): number {
  if (max < min) {
    throw new Error(`Invalid range (${min}, ${max})`);
  }
  return min + rng() * (max - min);
}

export function shuffleInPlace<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  return shuffleInPlace([...items], rng);
}

export function pickOne<T>(items: readonly T[], rng: Rng): T {
  if (items.length === 0) {
    throw new Error("Cannot pick from empty collection.");
  }
  const index = Math.floor(rng() * items.length);
  return items[index]!;
}

export function deriveSeed(base?: string | null): string {
  if (base && base.trim()) return base.trim();
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)
    .toString(36)
    .padStart(4, "0")}`;
}
