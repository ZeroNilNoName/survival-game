/* ==========================================================================
   WORLDGEN — shared procedural world engine (survival-game)
   --------------------------------------------------------------------------
   Portable subset of the TERRAFORGE planet generator, adapted for an
   INFINITE, FLAT, top-down 2D world that is generated on demand:

     TECTAFORGE feature                     -> here
     ------------------------------------------------------------------
     seeded RNG (mulberry32) + FNV hash     -> kept as-is
     2D simplex noise + fbm                 -> kept as-is
     domain warping (organic continents)    -> kept as-is
     tectonic plate simulation (~650 My)    -> DROPPED  (needs a fixed-size
                                                whole-map simulation; this
                                                world is infinite + chunked)
     altitude / lapse rate / sea level      -> DROPPED  (the map is flat; the
                                                continent field is only used
                                                to separate land / coast /
                                                sea, never displayed)
     latitude temperature bands + sea ice   -> DROPPED  (infinite world has
                                                no poles; temperature is a
                                                large-scale noise field)
     wind-carried humidity + rain shadows   -> PORTED as a local, chunk-safe
                                                approximation: a fixed wind
                                                direction + slope comparison
     rivers (priority flood + discharge)    -> PORTED as ridged-noise rivers
                                                on a warped domain, with
                                                width that grows downstream
                                                and in humid climates
     lakes (depression filling)             -> PORTED as noise-band lakes
     beaches from distance-to-water         -> kept (computed per chunk with
                                                a margin ring)
     land origin (sedimentary / intrusive / -> PORTED as a hidden geology
     magmatic)                                 layer that drives ore placement
     Whittaker biome classification         -> kept (temp x moisture matrix)

   Works both in the browser (window.WorldGen) and in Node (module.exports),
   so the client and the multiplayer server generate the identical world
   from the same seed.

   Pipeline per tile (all fields are pure functions of (seed, x, y), so any
   chunk can be generated independently at any time):
     1. CONTINENT — domain-warped fbm            -> land / coast / sea mask
     2. CLIMATE   — temperature fbm (large scale)
                    humidity fbm + hot-belt coupling + rain shadow
     3. WATER     — ridged rivers (variable width), noise lakes
     4. GEOLOGY   — sedimentary basins / intrusive cratons / magmatic belts
     5. BIOME     — Whittaker temp x moisture matrix, beaches, shallow shelf
   ========================================================================== */

(function (global) {
  'use strict';

  /* ---------------- seeded RNG (ported from TERRAFORGE) ---------------- */

  function hashSeed(str) {
    str = String(str);
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------- 2D simplex noise (ported from TERRAFORGE) ---------------- */

  var F2 = 0.5 * (Math.sqrt(3) - 1);
  var G2 = (3 - Math.sqrt(3)) / 6;
  var GRAD = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];

  function Simplex(rand) {
    var p = new Uint8Array(256), i, j, t;
    for (i = 0; i < 256; i++) p[i] = i;
    for (i = 255; i > 0; i--) {
      j = Math.floor(rand() * (i + 1));
      t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  Simplex.prototype.noise = function (x, y) {
    var perm = this.perm, n = 0, t0, t1, t2, g;
    var s = (x + y) * F2;
    var i = Math.floor(x + s), j = Math.floor(y + s);
    var t = (i + j) * G2;
    var x0 = x - (i - t), y0 = y - (j - t);
    var i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    var x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    var x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    var ii = i & 255, jj = j & 255;
    t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { g = GRAD[perm[ii + perm[jj]] % 12]; t0 *= t0; n += t0 * t0 * (g[0] * x0 + g[1] * y0); }
    t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { g = GRAD[perm[ii + i1 + perm[jj + j1]] % 12]; t1 *= t1; n += t1 * t1 * (g[0] * x1 + g[1] * y1); }
    t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { g = GRAD[perm[ii + 1 + perm[jj + 1]] % 12]; t2 *= t2; n += t2 * t2 * (g[0] * x2 + g[1] * y2); }
    return 70 * n; /* roughly -1..1 */
  };

  function fbm(noise, x, y, oct) {
    var amp = 1, freq = 1, sum = 0, norm = 0;
    for (var o = 0; o < oct; o++) {
      sum += amp * noise.noise(x * freq, y * freq);
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  }

  /* ---------------- math helpers (ported from TERRAFORGE) ---------------- */

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function sstep(a, b, x) {
    if (a === b) return x < a ? 0 : 1;
    var t = (x - a) / (b - a);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return t * t * (3 - 2 * t);
  }

  /* ---------------- biome / geology codes ---------------- */

  var BIOME_NAMES = [
    'SEA', 'SHALLOW_SEA', 'RIVER', 'LAKE',
    'BEACH_SAND', 'BEACH_CLAY',
    'DESERT', 'SAVANNA', 'STEPPE', 'PLAIN',
    'FOREST', 'JUNGLE', 'SWAMP',
    'TAIGA', 'TUNDRA'
  ];
  var B_SEA = 0, B_SHALLOW = 1, B_RIVER = 2, B_LAKE = 3, B_BSAND = 4, B_BCLAY = 5,
      B_DESERT = 6, B_SAVANNA = 7, B_STEPPE = 8, B_PLAIN = 9, B_FOREST = 10,
      B_JUNGLE = 11, B_SWAMP = 12, B_TAIGA = 13, B_TUNDRA = 14;

  var GEO_NAMES = ['SEDIMENTARY', 'INTRUSIVE', 'MAGMATIC', 'WATER'];
  var G_SED = 0, G_INT = 1, G_MAG = 2, G_WATER = 3;

  function isWaterBiomeId(id) {
    return id === B_SEA || id === B_SHALLOW || id === B_RIVER || id === B_LAKE;
  }

  /* ---------------- engine state ---------------- */

  var CHUNK_SIZE = 16;         /* tiles per chunk side                    */
  var CHUNK_MARGIN = 2;        /* extra ring sampled around a chunk so    */
                               /* beaches / coast detection are seamless  */
  var MAX_CACHED_CHUNKS = 512; /* LRU budget (~512 * 16 * 16 tiles)       */

  /* continental shelf: sea level in continent-field units (0..1) */
  var SEA_LEVEL = 0.52;
  /* how far below sea level still counts as shallow coastal water */
  var SHALLOW_BAND = 0.028;

  var nCont = null, nWarp = null, nTemp = null, nHum = null,
      nRiv = null, nRivWarp = null, nLake = null,
      nGeoA = null, nGeoB = null, nGeoC = null, nMisc = null;

  var chunks = new Map();      /* "cx,cy" -> chunk object (insertion-ordered LRU) */
  var activeSeed = null;

  function initNoise(seedHash) {
    nCont     = new Simplex(mulberry32((seedHash ^ 0x9e3779b9) >>> 0));
    nWarp     = new Simplex(mulberry32((seedHash + 101) >>> 0));
    nTemp     = new Simplex(mulberry32((seedHash + 202) >>> 0));
    nHum      = new Simplex(mulberry32((seedHash + 303) >>> 0));
    nRiv      = new Simplex(mulberry32((seedHash + 404) >>> 0));
    nRivWarp  = new Simplex(mulberry32((seedHash + 505) >>> 0));
    nLake     = new Simplex(mulberry32((seedHash + 606) >>> 0));
    nGeoA     = new Simplex(mulberry32((seedHash + 707) >>> 0));
    nGeoB     = new Simplex(mulberry32((seedHash + 808) >>> 0));
    nGeoC     = new Simplex(mulberry32((seedHash + 909) >>> 0));
    nMisc     = new Simplex(mulberry32((seedHash + 1111) >>> 0));
  }

  /* ==========================================================================
     FIELDS — every field is a pure function of the tile coordinates,
     so chunks are fully independent and the infinite world is seamless.
     ========================================================================== */

  /* Continent field 0..1 (hidden; the world map itself is flat).
     Domain warping (from TERRAFORGE) bends the noise domain so coastlines
     come out organic instead of blobby. */
  function continentAt(tx, ty) {
    var wx = tx + 55 * fbm(nWarp, tx * 0.004, ty * 0.004, 2);
    var wy = ty + 55 * fbm(nWarp, tx * 0.004 + 137.3, ty * 0.004 + 91.7, 2);
    var e = fbm(nCont, wx * 0.0042, wy * 0.0042, 4);       /* -1..1 */
    return clamp01(e * 0.5 + 0.5);
  }

  /* Temperature 0..1 — very large-scale climate regions.
     (No latitude: the world is infinite in every direction.) */
  function temperatureAt(tx, ty) {
    var t = 0.5 + 0.5 * fbm(nTemp, tx * 0.0028, ty * 0.0028, 3);
    t += 0.045 * fbm(nTemp, tx * 0.02 + 400, ty * 0.02 + 400, 2);
    return clamp01(t);
  }

  /* Humidity 0..1 — large-scale moisture field with two couplings:
       - hot regions hold less moisture (subtropical desert belts)
       - prevailing wind from the west: rising slopes (windward) get rain,
         leeward slopes sit in a rain shadow (TERRAFORGE's orographic
         rain-out, reduced to a local slope comparison so it stays
         chunk-safe) */
  function humidityAt(tx, ty, cont, temp) {
    var h = 0.5 + 0.5 * fbm(nHum, tx * 0.0045, ty * 0.0045, 3);
    h *= 1.07 - 0.16 * temp;                       /* hot -> drier        */

    var contUpwind = continentAt(tx - 10, ty);      /* wind from the west  */
    var climb = cont - contUpwind;                  /* >0 rising, <0 lee   */
    if (climb > 0) h *= 1 + 0.22 * Math.min(1, climb * 26);          /* windward  */
    else           h *= 1 - 0.45 * Math.min(1, -climb * 26);         /* rain shadow */

    h += 0.06 * fbm(nHum, tx * 0.03 + 800, ty * 0.03 + 800, 2);
    return clamp01(h);
  }

  /* River test — ridged noise on its own warped domain: the zero contours
     of a 2D noise field form connected, river-like curves. The channel is
     wider in humid climates and wider near the sea (downstream discharge),
     and rivers only exist on land, never inside the ocean. */
  function riverAt(tx, ty, cont, hum) {
    if (cont < SEA_LEVEL + 0.012) return false;    /* not on open ocean floor */
    var wx = tx + 40 * fbm(nRivWarp, tx * 0.006, ty * 0.006, 2);
    var wy = ty + 40 * fbm(nRivWarp, tx * 0.006 + 55.5, ty * 0.006 + 77.7, 2);
    var ridge = Math.abs(fbm(nRiv, wx * 0.013, wy * 0.013, 4));
    var wet = sstep(0.18, 0.75, hum);              /* arid -> thin rivers  */
    var inland = sstep(SEA_LEVEL + 0.05, SEA_LEVEL + 0.40, cont);
    var width = (0.012 + 0.026 * wet) * (1.22 - 0.55 * inland);
    return ridge < width;
  }

  /* Lake test — smooth noise band: broad blobs with irregular shores. */
  function lakeAt(tx, ty) {
    var l = fbm(nLake, tx * 0.012, ty * 0.012, 3);
    l += 0.05 * fbm(nLake, tx * 0.05 + 300, ty * 0.05 + 300, 2);
    return l > 0.60;
  }

  /* Geology — TERRAFORGE's land-origin classifier reduced to pure noise:
       MAGMATIC    — ridged bands (volcanic arcs / rift lines)  -> Cu, Fe, S
       SEDIMENTARY — broad depositional basins (lowlands)       -> coal
       INTRUSIVE   — ancient cratons between the belts          -> tin
     Only meaningful on land. */
  function geologyAt(tx, ty) {
    var belt = Math.abs(fbm(nGeoA, tx * 0.0055, ty * 0.0055, 3));
    var basin = fbm(nGeoB, tx * 0.0038, ty * 0.0038, 3);
    var jitter = 0.05 * fbm(nGeoC, tx * 0.05, ty * 0.05, 2);
    if (belt > 0.40 + jitter) return G_MAG;
    if (basin > -0.01 + jitter) return G_SED;
    return G_INT;
  }

  /* ==========================================================================
     CHUNK GENERATION
     Samples the chunk plus a margin ring, classifies every tile once and
     caches the result. Beaches need to know whether a neighbour is sea,
     hence the margin. All arrays are sampled in one pass for cache locality.
     ========================================================================== */

  function generateChunk(cx, cy) {
    var S = CHUNK_SIZE + CHUNK_MARGIN * 2;          /* sampled side length */
    var N = S * S;
    var baseX = cx * CHUNK_SIZE - CHUNK_MARGIN;
    var baseY = cy * CHUNK_SIZE - CHUNK_MARGIN;

    var cont = new Float32Array(N);
    var temp = new Float32Array(N);
    var hum = new Float32Array(N);
    var water = new Uint8Array(N);                  /* 1 = any water tile  */
    var sea = new Uint8Array(N);                    /* 1 = sea/shallow     */
    var biomeM = new Uint8Array(N);                 /* margin-inclusive    */

    var x, y, i, idx;
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        i = y * S + x;
        var tx = baseX + x, ty = baseY + y;
        var c = continentAt(tx, ty);
        cont[i] = c;

        var b;
        if (lakeAt(tx, ty) && c >= SEA_LEVEL) {
          /* lakes only exist on land — never teal speckles in the ocean */
          b = B_LAKE;
        } else if (c < SEA_LEVEL + 0.012) {
          /* ocean / shelf: no need for climate fields here */
          b = (c >= SEA_LEVEL - SHALLOW_BAND) ? B_SHALLOW : B_SEA;
        } else {
          /* land-candidate tile: rivers need the humidity first */
          temp[i] = temperatureAt(tx, ty);
          hum[i] = humidityAt(tx, ty, c, temp[i]);
          b = riverAt(tx, ty, c, hum[i]) ? B_RIVER : 255;
        }
        biomeM[i] = b;
        water[i] = (b <= B_LAKE) ? 1 : 0;
        sea[i] = (b === B_SEA || b === B_SHALLOW) ? 1 : 0;
      }
    }

    /* Beaches: land tiles directly adjacent to the sea (not lake/river
       banks) become sand or clay shores, chosen by a low-frequency noise
       so each coastal region is consistently one material. */
    var chunk = {
      cx: cx, cy: cy,
      biome: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE),
      geo: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE)
    };

    for (y = 0; y < CHUNK_SIZE; y++) {
      for (x = 0; x < CHUNK_SIZE; x++) {
        var mi = (y + CHUNK_MARGIN) * S + (x + CHUNK_MARGIN);  /* margin index */
        var b = biomeM[mi];

        if (b === 255) {
          var tx = cx * CHUNK_SIZE + x, ty = cy * CHUNK_SIZE + y;
          var nearSea = sea[mi - 1] || sea[mi + 1] || sea[mi - S] || sea[mi + S];
          var t = temp[mi], h = hum[mi];
          var lowland = sstep(SEA_LEVEL + 0.16, SEA_LEVEL + 0.02, cont[mi]); /* 1 near coast */

          if (nearSea) {
            var shoreNoise = fbm(nMisc, tx * 0.008, ty * 0.008, 2);
            b = (shoreNoise > 0) ? B_BSAND : B_BCLAY;
          } else if (t < 0.34) {
            b = (h < 0.42) ? B_TUNDRA : B_TAIGA;
          } else if (t < 0.62) {
            if (h < 0.32) b = B_STEPPE;
            else if (h < 0.58) b = B_PLAIN;
            else if (h < 0.78) b = B_FOREST;
            else b = (lowland > 0.5) ? B_SWAMP : B_FOREST;   /* wet lowland */
          } else {
            if (h < 0.34) b = B_DESERT;
            else if (h < 0.60) b = B_SAVANNA;
            else if (h < 0.82) b = B_JUNGLE;
            else b = (lowland > 0.5) ? B_SWAMP : B_JUNGLE;   /* wet lowland */
          }
        }

        idx = y * CHUNK_SIZE + x;
        chunk.biome[idx] = b;
        chunk.geo[idx] = water[mi] ? G_WATER : geologyAt(cx * CHUNK_SIZE + x, cy * CHUNK_SIZE + y);
      }
    }
    return chunk;
  }

  function getChunk(cx, cy) {
    var key = cx + ',' + cy;
    var c = chunks.get(key);
    if (c) {
      /* refresh LRU position */
      chunks.delete(key);
      chunks.set(key, c);
      return c;
    }
    c = generateChunk(cx, cy);
    chunks.set(key, c);
    if (chunks.size > MAX_CACHED_CHUNKS) {
      /* evict the oldest inserted chunk */
      var oldest = chunks.keys().next().value;
      chunks.delete(oldest);
    }
    return c;
  }

  /* ==========================================================================
     PUBLIC API
     ========================================================================== */

  function init(seed) {
    var h = hashSeed(seed);
    if (activeSeed === h && nCont) return;          /* same world already */
    activeSeed = h;
    initNoise(h);
    chunks.clear();
  }

  function getBiomeAt(tx, ty) {
    var cx = Math.floor(tx / CHUNK_SIZE), cy = Math.floor(ty / CHUNK_SIZE);
    var c = getChunk(cx, cy);
    var lx = tx - cx * CHUNK_SIZE, ly = ty - cy * CHUNK_SIZE;
    return c.biome[ly * CHUNK_SIZE + lx];
  }

  function getBiomeNameAt(tx, ty) {
    return BIOME_NAMES[getBiomeAt(tx, ty)];
  }

  function getGeologyAt(tx, ty) {
    var cx = Math.floor(tx / CHUNK_SIZE), cy = Math.floor(ty / CHUNK_SIZE);
    var c = getChunk(cx, cy);
    var lx = tx - cx * CHUNK_SIZE, ly = ty - cy * CHUNK_SIZE;
    return c.geo[ly * CHUNK_SIZE + lx];
  }

  function isWaterAt(tx, ty) {
    return isWaterBiomeId(getBiomeAt(tx, ty));
  }

  /* Spiral search for a spawnable land tile (not water, not a beach).
     Used so new games never start in the middle of the ocean. */
  function findSpawnNear(tx, ty, maxR) {
    maxR = maxR || 256;
    var r, dx, dy, bx = tx, by = ty, found = false;
    /* quick check of the centre itself */
    if (!isWaterAt(tx, ty)) { var b0 = getBiomeAt(tx, ty); if (b0 !== B_BSAND && b0 !== B_BCLAY) return [tx, ty]; }
    for (r = 1; r <= maxR && !found; r += 2) {
      for (dy = -r; dy <= r && !found; dy++) {
        for (dx = -r; dx <= r && !found; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   /* ring only */
          var x = tx + dx, y = ty + dy;
          if (isWaterAt(x, y)) continue;
          var b = getBiomeAt(x, y);
          if (b === B_BSAND || b === B_BCLAY) continue;
          bx = x; by = y; found = true;
        }
      }
    }
    if (!found) { /* fallback: any land tile */
      for (r = 1; r <= maxR && !found; r += 2) {
        for (dy = -r; dy <= r && !found; dy++) {
          for (dx = -r; dx <= r && !found; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            if (!isWaterAt(tx + dx, ty + dy)) { bx = tx + dx; by = ty + dy; found = true; }
          }
        }
      }
    }
    return [bx, by];
  }

  function clearCache() { chunks.clear(); }

  /* self-initialize with a neutral seed so accidental calls before init()
     (e.g. from the main menu) never crash; the game re-inits on start */
  init(0);

  var api = {
    init: init,
    getBiomeAt: getBiomeAt,
    getBiomeNameAt: getBiomeNameAt,
    getGeologyAt: getGeologyAt,
    isWaterAt: isWaterAt,
    isWaterBiomeId: isWaterBiomeId,
    findSpawnNear: findSpawnNear,
    clearCache: clearCache,
    CHUNK_SIZE: CHUNK_SIZE,
    SEA_LEVEL: SEA_LEVEL,
    BIOME_NAMES: BIOME_NAMES,
    GEO_NAMES: GEO_NAMES,
    /* biome id constants */
    B_SEA: B_SEA, B_SHALLOW: B_SHALLOW, B_RIVER: B_RIVER, B_LAKE: B_LAKE,
    B_BSAND: B_BSAND, B_BCLAY: B_BCLAY, B_DESERT: B_DESERT, B_SAVANNA: B_SAVANNA,
    B_STEPPE: B_STEPPE, B_PLAIN: B_PLAIN, B_FOREST: B_FOREST, B_JUNGLE: B_JUNGLE,
    B_SWAMP: B_SWAMP, B_TAIGA: B_TAIGA, B_TUNDRA: B_TUNDRA,
    G_SED: G_SED, G_INT: G_INT, G_MAG: G_MAG, G_WATER: G_WATER,
    hashSeed: hashSeed,
    /* raw fields (debug / minimap tools) */
    _continentAt: continentAt,
    _temperatureAt: temperatureAt,
    _humidityAt: humidityAt
  };

  global.WorldGen = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
