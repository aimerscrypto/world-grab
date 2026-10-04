// ============================================================================
//  WORLD GRAB — central tuning file.
//  Every gameplay / visual / performance number lives here so balance can be
//  tweaked without hunting through the code. Units:
//    - "s"      seconds of game time (affected by the 1x/2x speed toggle)
//    - "u"      map units; every map is normalised to MAP_WIDTH units wide
//    - "unit"   multiples of the per-map scale unit (see map.unitScale)
// ============================================================================

export type Difficulty = 'easy' | 'normal' | 'hard';

export const CONFIG = {
  // --------------------------------------------------------------------------
  // MAP BUILD
  // --------------------------------------------------------------------------
  map: {
    /** Every region is projected so the board is this many units wide. */
    width: 100,
    /** Fraction of arc points kept after topology-preserving simplification.
     *  Lower = faster build + fewer triangles, higher = smoother coasts. */
    simplifyKeep: { world: 0.16, europe: 0.42, africa: 0.4, asia: 0.3, namerica: 0.32, samerica: 0.42, oceania: 0.5 } as Record<string, number>,
    /** d3 projection resampling precision (px at a 1000px wide board). */
    projectionPrecision: 2.5,
    /** Polygons (islets) smaller than this fraction of the board area are dropped,
     *  unless they are the only polygon of a country. */
    minPolygonAreaFrac: 0.000004,
    /** Countries whose projected area is below this fraction of the board area
     *  get a round tappable token instead of relying on their tiny shape. */
    tinyCountryAreaFrac: 0.00012,
    /** Non-independent territories smaller than this (km²) are merged into a
     *  neighbour (if one exists) or dropped entirely. */
    minTerritoryAreaKm2: 5000,
    /** Countries never shown. 010 Antarctica, 260 French Southern Lands. */
    exclude: ['010', '260', '334', '239', '086'],
    /** Features without usable metadata (or tiny territories) merged explicitly
     *  into another country (by name for id-less features, else by ccn3). */
    mergeInto: {
      'Kosovo': '688',
      'N. Cyprus': '196',
      'Somaliland': '706',
      'Siachen Glacier': '356',
      '344': '156', // Hong Kong -> China
      '446': '156', // Macao -> China
      '663': '__drop', // St-Martin (tiny shared island)
      '534': '__drop',
    } as Record<string, string>,
    /** Keep only the polygons of a country whose centroid lies in this
     *  lon/lat box [minLon, minLat, maxLon, maxLat] (strips far overseas parts). */
    polygonFilters: {
      '250': [-10, 40, 20, 52], // France: metropolitan + Corsica
      '528': [2, 50, 8, 54], // Netherlands: European part
      '578': [-15, 55, 40, 85], // Norway: drop Bouvet
      '036': [100, -45, 160, -5], // Australia: drop sub-antarctic islands
      '554': [160, -48, 179.9, -30], // New Zealand: drop Chatham/subantarctic
      '152': [-80, -60, -60, -15], // Chile: drop Easter Island
      '840': [-180, 15, -60, 75], // USA: drop the Aleutian tail west of 180
      '643': [-180, 40, 180, 82], // Russia (keeps everything but sanity box)
    } as Record<string, [number, number, number, number]>,
    /** Sea routes: islands / isolated land clusters get routes to every
     *  country whose coast is within this many km. */
    seaRouteMaxKm: 700,
    /** Max sea routes per country (closest first) to avoid spaghetti. */
    seaRouteMaxPerCountry: 4,
    /** Hard cap on drawn sea route length as fraction of board width
     *  (prevents wrap-around lines on the world map). */
    seaRouteMaxBoardFrac: 0.25,
  },

  // --------------------------------------------------------------------------
  // LOOK — colours are sRGB hex
  // --------------------------------------------------------------------------
  colors: {
    neutral: 0xd9cdb6, // soft warm sand
    background: 0x31475c, // non-playable land on a region map
    player: 0x2f7dff, // vivid blue
    bots: [0xe8423f, 0xff9a1f, 0x9b51e0, 0x2dbe6c, 0xec4899], // red, orange, purple, green, pink
    oceanDeep: 0x071a2e,
    oceanMid: 0x0d3550,
    oceanShallow: 0x1d7f8c,
    grid: 0x6fc3d6,
    outlineNeutral: 0xfff4de,
    sky: 0x050f1c, // clear colour behind everything
    invalid: 0xff3b3b,
  },
  faction: {
    playerName: 'You',
    botNames: ['Crimson', 'Amber', 'Violet', 'Jade', 'Rose'],
  },

  // --------------------------------------------------------------------------
  // DIORAMA GEOMETRY (in "unit" = per-map scale unit)
  // --------------------------------------------------------------------------
  slab: {
    height: 0.55, // neutral slab height
    ownedExtra: 0.32, // owned countries are this much taller
    backgroundHeight: 0.22, // non-playable land
    bevelSize: 0.07,
    bevelThickness: 0.06,
    hoverLift: 0.12,
    captureBounce: 0.55, // peak extra height of the capture bounce
    edgeGlowWidth: 0.42, // inner glow ribbon width
    tokenRadius: 0.55, // tiny-country token radius
  },
  /** Per-map scale unit = clamp(sqrt(boardArea / playableCount) * factor). */
  unitScale: { factor: 0.085, min: 0.32, max: 1.1 },

  // --------------------------------------------------------------------------
  // CAMERA
  // --------------------------------------------------------------------------
  camera: {
    fov: 38,
    tiltDeg: 24, // tilt from straight-down
    minZoomFrac: 0.12, // closest distance as a fraction of the fit distance
    maxZoomFrac: 1.25, // furthest distance as a fraction of the fit distance
    damping: 10, // higher = snappier zoom/pan smoothing
    inertiaDamping: 4.5, // pan inertia decay after releasing a drag
    wheelZoomStep: 0.0015, // zoom per wheel delta pixel
    flyDuration: 0.9,
    fitPadding: 1.04, // >1 leaves a bit of ocean around the region
    attractDriftSpeed: 0.035, // radians/s of the title screen camera drift
    shakeDecay: 6,
  },

  // --------------------------------------------------------------------------
  // GAMEPLAY
  // --------------------------------------------------------------------------
  game: {
    defaultBots: 3,
    startTroops: 30,
    /** Fraction of a country's troops sent per drag. */
    sendFraction: 0.6,
    /** A country never sends its last troop(s). */
    minKeep: 1,
    /** Allow sending from any of your countries that is connected (through
     *  your own territory) to a country bordering the target. If false, only
     *  direct neighbours may be attacked. */
    sendThroughTerritory: true,
    /** Growth tiers by real-world area (km²). Bigger countries grow faster and
     *  hold more. `garrison` = neutral starting troops. */
    tiers: [
      { maxArea: 25_000, rate: 0.55, cap: 45, garrison: 5 },
      { maxArea: 120_000, rate: 0.8, cap: 65, garrison: 9 },
      { maxArea: 400_000, rate: 1.05, cap: 85, garrison: 13 },
      { maxArea: 1_500_000, rate: 1.35, cap: 110, garrison: 18 },
      { maxArea: Infinity, rate: 1.7, cap: 140, garrison: 24 },
    ],
    /** Owned countries above cap slowly bleed back down (per second). */
    overCapDecay: 1.2,
    /** Travel time (s) for a typical neighbour distance — speed is derived
     *  per map from this so every region plays at the same pace. */
    typicalTravelSeconds: 2.4,
    /** Visual units emitted per second per send stream. */
    unitsPerSecond: 16,
    /** Max visual units per send; troops are split evenly between them. */
    maxUnitsPerSend: 40,
    /** Global cap on simultaneously animated units (pool size). */
    maxUnits: 2400,
    /** Ownership snapshot interval for the end-of-match timelapse (s). */
    snapshotInterval: 2,
    /** Combo window: captures within this many seconds chain. */
    comboWindow: 2.6,
    speeds: [1, 2],
  },

  // --------------------------------------------------------------------------
  // BOTS
  // --------------------------------------------------------------------------
  bots: {
    easy: {
      thinkInterval: [2.6, 4.2], // seconds between decisions [min,max]
      reactionDelay: [0.4, 1.4], // extra human-like delay before acting
      attackAdvantage: 1.9, // need troops >= target * this
      neutralAdvantage: 1.5,
      maxActionsPerThink: 1,
      reinforceChance: 0.25,
      gangUpThreshold: 0.6, // gang up on a faction owning this share
      growthMultiplier: 0.9,
    },
    normal: {
      thinkInterval: [1.5, 2.6],
      reactionDelay: [0.25, 0.9],
      attackAdvantage: 1.45,
      neutralAdvantage: 1.25,
      maxActionsPerThink: 2,
      reinforceChance: 0.45,
      gangUpThreshold: 0.45,
      growthMultiplier: 1,
    },
    hard: {
      thinkInterval: [0.8, 1.5],
      reactionDelay: [0.1, 0.45],
      attackAdvantage: 1.2,
      neutralAdvantage: 1.1,
      maxActionsPerThink: 3,
      reinforceChance: 0.65,
      gangUpThreshold: 0.35,
      growthMultiplier: 1.12,
    },
    /** Bots get bolder as matches drag on: advantage requirement is divided
     *  by (1 + aggressionRamp * minutes), floored at 1.05. */
    aggressionRamp: 0.08,
    /** Attract-mode (title screen) bot settings. */
    attractDifficulty: 'normal' as Difficulty,
    attractSpeed: 1.6,
    attractMaxSeconds: 260,
  } satisfies Record<string, unknown>,

  // --------------------------------------------------------------------------
  // FX / JUICE
  // --------------------------------------------------------------------------
  fx: {
    bloomStrength: 0.55,
    bloomRadius: 0.5,
    bloomThreshold: 0.82,
    captureWipeSeconds: 0.75,
    shockwaveSeconds: 1.1,
    shakeBigCapture: 0.35, // camera shake amount (unit-relative) for big captures
    bigCaptureTroops: 40,
    sparksPerClash: 3,
    maxSparks: 600,
    floatTextSeconds: 1.6,
    attackPulseCooldown: 1.6, // min seconds between screen-edge pulses
    badgeLerp: 12, // number roll-up speed on badges
  },

  // --------------------------------------------------------------------------
  // PERFORMANCE
  // --------------------------------------------------------------------------
  perf: {
    maxPixelRatio: 2,
    minPixelRatio: 0.75,
    /** If the smoothed FPS stays below this for `downgradeAfter` seconds,
     *  quality steps down (bloom off, then lower pixel ratio). */
    lowFps: 42,
    downgradeAfter: 2.5,
    /** Badges for neutral countries hide when their screen size is below this (px). */
    neutralBadgeMinPx: 26,
  },

  // --------------------------------------------------------------------------
  // AUDIO
  // --------------------------------------------------------------------------
  audio: {
    masterVolume: 0.7,
    musicVolume: 0.22,
    sfxVolume: 0.8,
    marchTickInterval: 0.11, // min seconds between marching ticks
  },
};

export type BotProfile = (typeof CONFIG.bots)['normal'];
