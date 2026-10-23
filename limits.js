// Limits shared by the game server and the client patch.
export const MAX_XP = 10_000_000_000_000; // 10 trillion: XP cap, and where tier 17 reaches full size

// XP needed for each tier (index 0 = tier 1), replacing mope.io's 0, 100, 400, … 10M table: tier 2
// at 100 and tier 17 at 1 trillion, each tier about ×4.64 the one before (rounded to 2 figures).
export const TIER_XP = [0, ...Array.from({ length: 16 }, (_, i) => {
  const v = 100 * 10 ** ((i * 2) / 3);
  const step = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.round(v / step) * step;
})];
