// Pumpkin variants: spawn chances and XP. The order is the client's pumpkin subspecies id
// (0-6 are mope.io's own; 7-10 are ours, added to the client by patch-client.ts and drawn from
// custom-assets/terrain/pumpkin/<id>/, made by tools/make-pumpkins.py).
//
// weight: spawn chance out of the total (1000 here, so 35 = 3.5%)
// xp17:   XP for collecting it at tier 17; each tier below gets half of the tier above it
//         (tier 16 = xp17 / 2, tier 15 = xp17 / 4, ... tier 1 = xp17 / 65536)
export const PUMPKINS = [
  { id: "normal", name: "Pumpkin", weight: 480, xp17: 20_000 },
  { id: "jack", name: "Jack-o'-lantern", weight: 250, xp17: 50_000 },
  { id: "gold", name: "Gold", weight: 120, xp17: 150_000 },
  { id: "emerald", name: "Emerald", weight: 60, xp17: 300_000 },
  { id: "ruby", name: "Ruby", weight: 14, xp17: 440_000 },
  { id: "diamond", name: "Diamond", weight: 5, xp17: 1_200_000 },
  { id: "onyx", name: "Onyx", weight: 2, xp17: 2_500_000 },
  { id: "amber", name: "Amber", weight: 35, xp17: 400_000 }, // rarer than emerald
  { id: "sapphire", name: "Sapphire", weight: 22, xp17: 550_000 }, // next after amber
  { id: "amethyst", name: "Amethyst", weight: 9, xp17: 800_000 },
  { id: "black_hole", name: "Black Hole", weight: 3, xp17: 2_000_000 }, // next after diamond
];

// Rarity from most to least common (by weight):
// normal, jack, gold, emerald, amber, sapphire, ruby, amethyst, diamond, black_hole, onyx

export const PUMPKIN_COLOURS = ["#ffa500", "#deb887", "#ffd700", "#6adb41", "#e4384c", "#38e4e1", "#3b3b46", "#fc6b01", "#002aa6", "#390b71", "#6514c0"];

export function pickPumpkin(random = Math.random) {
  const total = PUMPKINS.reduce((s, p) => s + p.weight, 0);
  let r = random() * total;
  for (let i = 0; i < PUMPKINS.length; i++) if ((r -= PUMPKINS[i].weight) < 0) return i;
  return 0;
}

export function pumpkinXP(variant, tier, topTier = 17) {
  return Math.max(1, Math.round(PUMPKINS[variant].xp17 / 2 ** (topTier - tier)));
}
