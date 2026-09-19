/**
 * The synthetic catalog corpus.
 *
 * Everything the seeder needs to make a listing look like it came off a real
 * marketplace: brands that belong to their category, spec keys a buyer in that
 * category would actually scan for, price bands with the right order of
 * magnitude, and a source/condition mix that matches how the category really
 * trades. It is pure data plus lookup helpers — no randomness lives here, the
 * seeder owns the RNG so the catalog stays reproducible.
 *
 * Three downstream systems read these numbers directly, which is why the price
 * bands are tuned rather than guessed: the ranker's price prior, the Window
 * quad's price-band coherence rule, and the scam detector's price-anomaly
 * signal all compare a listing against its L2 band.
 */

import { hashString, L2_TOPICS } from '@window/shared';
import type { Condition, SourceType } from '@window/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BrandTier = 'budget' | 'mid' | 'premium';

/** The normalized unit vocabulary. `null` means the spec is enumerated, not measured. */
export type SpecUnit = 'mm' | 'g' | 'W' | 'Hz' | 'in' | 'cm' | 'ml' | 'L' | null;

export interface SpecKeySpec {
  key: string;
  unit: SpecUnit;
  values: string[];
}

/** Weights over `SourceType`, summing to 1. */
export type SourceTypeMix = Record<SourceType, number>;

/**
 * Weights over the 8-point condition scale, applied to the secondhand and
 * auction share only. Omitted points are zero; `assertCoverage` checks the
 * present weights sum to 1.
 */
export type ConditionMix = Partial<Record<Condition, number>>;

export interface ReviewProfile {
  meanRating: number;
  /** Standard deviation of the per-review rating, on the 1-5 scale. */
  ratingSpread: number;
  typicalCount: number;
}

export interface L2Profile {
  id: string;
  l1: string;
  /** USD minor units. */
  priceRange: [number, number];
  specKeys: SpecKeySpec[];
  /** Placeholders: `{brand}` `{model}` `{l3}` `{spec}` `{color}`. */
  titlePatterns: string[];
  /** Placeholders: `{N}` digit run, `{A}` uppercase letter run, `{word}` codename. */
  modelPatterns: string[];
  sourceTypeMix: SourceTypeMix;
  conditionMix: ConditionMix;
  reviewProfile: ReviewProfile;
  /** Review themes that genuinely recur here; keys into `REVIEW_SNIPPETS`. */
  themes: string[];
}

export type ReviewPolarity = 'positive' | 'negative';
export type ReviewSnippetSet = Record<ReviewPolarity, string[]>;

// ---------------------------------------------------------------------------
// Shared presets
//
// Title shapes and secondhand condition curves repeat across dozens of L2s;
// naming them keeps the profile table readable and keeps the shapes consistent
// between categories that really do behave the same way.
// ---------------------------------------------------------------------------

const TITLE_SETS = {
  /** Model-number led: consumer electronics, tools, components. */
  tech: [
    '{brand} {model} {l3}',
    '{brand} {model} {l3} — {spec}',
    '{brand} {model} {l3} ({spec})',
    '{brand} {model} {l3} — {color}',
  ],
  /** Colour and size led: anything worn. */
  apparel: [
    '{brand} {l3} — {color}',
    '{brand} {model} {l3} in {color}',
    '{brand} {l3} ({spec})',
    '{brand} {model} {l3} — {spec}',
  ],
  /** Material and finish led: furniture, cookware, tableware. */
  homegoods: [
    '{brand} {model} {l3} — {color}',
    '{brand} {l3} in {spec}',
    '{brand} {model} {l3}',
    '{brand} {l3} — {spec}, {color}',
  ],
  /** Formulation led: no model numbers on a bottle of serum. */
  consumable: [
    '{brand} {l3} — {spec}',
    '{brand} {model} {l3}',
    '{brand} {model} {l3} — {spec}',
  ],
  /** Provenance led: the defining spec goes first because bidders filter on it. */
  lot: [
    '{brand} {l3} — {spec}',
    '{l3}, {spec} — {brand}',
    '{brand} {model} {l3} ({spec})',
  ],
  /** Fitment led: the buyer is matching a part to a machine. */
  fitment: [
    '{brand} {model} {l3} — {spec}',
    '{brand} {l3} {model}',
    '{brand} {model} {l3}',
  ],
} satisfies Record<string, string[]>;

type TitleSetName = keyof typeof TITLE_SETS;

const CONDITION_MIXES = {
  /** Categories where used stock is curated and sellers grade generously. */
  gently: { like_new: 0.26, excellent: 0.34, good: 0.28, fair: 0.09, poor: 0.03 },
  /** Consumer electronics: a real tail of dead units sold for parts. */
  electronics: {
    like_new: 0.18,
    excellent: 0.28,
    good: 0.3,
    fair: 0.13,
    poor: 0.07,
    for_parts: 0.04,
  },
  /** Worn goods: the middle of the scale dominates. */
  apparel: { like_new: 0.28, excellent: 0.3, good: 0.28, fair: 0.11, poor: 0.03 },
  /** Heavy use and outdoor exposure push the curve down. */
  hardUse: { excellent: 0.16, good: 0.38, fair: 0.27, poor: 0.13, for_parts: 0.06 },
  /** Sealed or graded: the point of the market is top-of-scale examples. */
  collector: { new: 0.12, like_new: 0.34, excellent: 0.34, good: 0.17, fair: 0.03 },
  /** Anything decades old: honest wear is the norm and provenance is patchy. */
  vintage: { excellent: 0.19, good: 0.37, fair: 0.25, poor: 0.12, unknown: 0.07 },
  /** Media: sleeve and disc grade separately, so the middle is fat. */
  media: { like_new: 0.16, excellent: 0.29, good: 0.35, fair: 0.14, poor: 0.06 },
  /** Instruments: playable is the floor, so the bottom of the scale is thin. */
  instrument: { like_new: 0.2, excellent: 0.34, good: 0.32, fair: 0.11, poor: 0.03 },
  /** Mechanical parts: sold with measured wear, plus a real core/rebuild trade. */
  mechanical: { excellent: 0.14, good: 0.36, fair: 0.26, poor: 0.14, for_parts: 0.1 },
  /** Safety and hygiene categories: the thin resale share is near-new only. */
  nearNew: { new: 0.16, like_new: 0.46, excellent: 0.28, good: 0.1 },
} satisfies Record<string, ConditionMix>;

type ConditionMixName = keyof typeof CONDITION_MIXES;

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

/** 25-40 category-appropriate brands per L1. Keyed by L1 id. */
export const BRANDS_BY_L1: Record<string, string[]> = {
  tech: [
    'Anvil Labs', 'Arclight', 'Aurex', 'Basalt Systems', 'Beacon Systems', 'Cobalt Works',
    'Corvid Devices', 'Darkline', 'Ferrite', 'Halcyon Micro', 'Helion', 'Hexon',
    'Ironwood Devices', 'Kestrel Systems', 'Lumen Works', 'Meridian Tech', 'Monolith',
    'Nordbyte', 'Northgate Digital', 'Novaform Electronics', 'Obsidian Peripherals', 'Oryx',
    'Paloma Devices', 'Quanta Lane', 'Redshift Labs', 'Sable Devices', 'Silverpine',
    'Skyward Micro', 'Tessellate', 'Thornbury Tech', 'Vantage Micro', 'Verity Labs',
    'Voltaic', 'Wayfinder Tech', 'Zenith Circuit',
  ],
  home: [
    'Alder & Ash', 'Amberstone', 'Bellwether Kitchen', 'Birchwood Home', 'Brackenhill',
    'Brightpan', 'Calder Kitchen', 'Cast & Copper', 'Cedarline', 'Clayworth', 'Copperfield',
    'Crestmont', 'Dalefield', 'Ember & Oak', 'Fieldstone', 'Forge & Flame', 'Gathering Table',
    'Greystone Home', 'Harlow Home', 'Hearthwell', 'Ironclad Cookware', 'Kettleford',
    'Larkspur Home', 'Millstone', 'Northfield Kitchen', 'Oakmere', 'Orchard Lane', 'Pemberton',
    'Quarry & Co', 'Rosewick', 'Saltbox Kitchen', 'Stonemill', 'Thistlewood', 'Verdant Kitchen',
    'Willowbank',
  ],
  furniture: [
    'Ansel & Roe', 'Ashgrove', 'Atelier Nord', 'Barrow & Pine', 'Bellamy Studio', 'Birchmont',
    'Bramble House', 'Carver & Co', 'Clementine Works', 'Cypress Row', 'Dovetail Studio',
    'Eastwick', 'Fenwick Furniture', 'Foundry Row', 'Habitat Nine', 'Hollis & Frame',
    'Juniper House', 'Knotwork', 'Larkfield', 'Linden & Main', 'Maple Row', 'Meadowgate',
    'Nordhaus', 'Oakhurst', 'Orlo', 'Pennant Home', 'Quarrywood', 'Rivet & Rail', 'Saltmarsh',
    'Sundry Studio', 'Teakhouse', 'Thistle & Co', 'Verdigris', 'Westbourne', 'Wren & Ivy',
  ],
  'fashion-men': [
    'Abbott & Drake', 'Alderton', 'Ashbourne', 'Barclay Row', 'Bellweather Co', 'Birchall',
    'Broadcloth', 'Caldwell & Sons', 'Cole Harbour', 'Corbin Supply', "Draper's Mill",
    'Eastgate Supply', 'Foxglove & Fell', 'Garrick', 'Halstead', 'Harrow Lane', 'Holloway',
    'Ironbound', 'Kingsmill', 'Lockwood', 'Mercer & Clay', 'Norwood Standard', 'Oakcliff',
    'Penfold', 'Quarterdeck', 'Ramsden', 'Sackville', 'Sterling Row', 'Tanner & Co',
    'Thatcher Goods', 'Vesper Tailoring', 'Westbrook', 'Whitlock', 'Winslow & Grey', 'Yarrow Co',
  ],
  'fashion-women': [
    'Amélie Rue', 'Aster & Vine', 'Belmont Atelier', 'Blythe', 'Calla', 'Camille Noor',
    'Cerise', 'Clove & Willow', 'Delphine', 'Edie Rowe', 'Élan Maison', 'Fable & Thread',
    'Fleur Noire', 'Gilda', 'Hermosa', 'Inès Lorne', 'Isolde', 'Juno Atelier', 'Lark & Lace',
    'Lilou', 'Maison Verre', 'Marguerite', 'Neroli', 'Odette', 'Opaline', 'Plume', 'Rosalind',
    'Saffron & Co', 'Selene', 'Sorrel', 'Tallulah', 'Verity Rowe', 'Vivienne Clay',
    'Wren Atelier', 'Yves & Marlow',
  ],
  sneakers: [
    'Apex Track', 'Asphalt Club', 'Backcourt', 'Blacktop Division', 'Brickline',
    'Cadence Athletics', 'Concrete Garden', 'Crosswalk', 'Deadstock Society', 'Dropcase',
    'Eightfold', 'Fault Line', 'Gridlock', 'Halfpipe Co', 'Hardpack', 'Kinetic Form',
    'Lowcut Union', 'Marathon Standard', 'Midnight Sprint', 'Nocturne Athletics', 'Overrun',
    'Panorama Sport', 'Pavement', 'Quarterline', 'Riser', 'Sidewalk Theory', 'Slipstream Co',
    'Stride Lab', 'Terminal Nine', 'Threadcount', 'Tracklist', 'Underpass', 'Velodrome Club',
    'Warmup', 'Zero Mile',
  ],
  watches: [
    'Aldrich & Vane', 'Ambroise', 'Astral Horology', 'Aurelia Fine', 'Beaumont', 'Bramley Jewels',
    'Brenner', 'Calibre Nord', 'Celeste Fine', 'Chronoform', 'Corvus Watch Co', 'Delacroix',
    'Eberhart', 'Farrow & Ives', 'Fathomwell', 'Girard Noir', 'Goldsmith Row', 'Halbrand',
    'Heimdall', 'Isochron', 'Jourdain', 'Kestrel Horology', 'Lumière Atelier', 'Marchand',
    'Maurer', 'Nordfjord', 'Octave Timepieces', 'Orion Timepieces', 'Perrin', 'Quill & Crown',
    'Ravensbourne', 'Serein', 'Solstice Watch Co', 'Vachel', 'Wexford', 'Zephyr Dial',
  ],
  beauty: [
    'Aeris Skin', 'Alba Rituals', 'Amaranth', 'Aster Botanics', 'Bellamy Beauty', 'Blush Theory',
    'Calendula Co', 'Cedar & Salt', 'Ciel', 'Clearfield', 'Dewpoint', 'Elixa', 'Ember Rose',
    'Flora Nine', 'Glasshouse Beauty', 'Halcyon Skin', 'Hinoki Lab', 'Isla Botanicals',
    'Juniper Skin', 'Lumeire', 'Maren', 'Meridian Skin', 'Noor Lab', 'Oléa', 'Petal & Pine',
    'Quiet Ritual', 'Rosewater Lab', 'Sable Beauty', 'Saffron Skin', 'Sylva', 'Terra Nine',
    'Velvet Hour', 'Verity Skin', 'Wilder Grooming', 'Yuzu Lab',
  ],
  fitness: [
    'Alpenglow', 'Ascentline', 'Backcountry Forge', 'Basecamp Nine', 'Bouldercraft', 'Cairn & Co',
    'Cascade Range', 'Cragline', 'Driftwood Outdoors', 'Eastface', 'Feldspar', 'Granite Peak',
    'Highwater', 'Ironpine', 'Kettle & Bar', 'Longtrail', 'Meridian Outdoor', 'Northwind Gear',
    'Overland Supply', 'Pinnacle Forge', 'Quarrystone Fitness', 'Ridgeline Co', 'Sablefield',
    'Scree', 'Silvercol', 'Skyline Athletics', 'Snowline', 'Summitworks', 'Talus',
    'Thermalite', 'Timberfall', 'Torrent Sports', 'Treeline Nine', 'Vertex Athletics', 'Windward',
  ],
  sports: [
    'Ace & Arbor', 'Backhand Co', 'Ballpark Nine', 'Baseline Athletics', 'Birdie & Bogey',
    'Bluecourt', 'Centerline Sports', 'Clubhouse Standard', 'Crossbar', 'Deepwater Tackle',
    'Doubles Club', 'Drop Shot', 'Fairway Forge', 'Fastpitch Co', 'Frontcourt',
    'Gridiron Standard', 'Halfcourt', 'Hardcourt Athletic', "Keeper's Union", 'Kingpin Sports',
    'Lure & Line', 'Matchpoint', 'Nettle Sports', 'Offcut Skateboards', 'Pitchside',
    'Powerline Sports', 'Reelcraft', 'Rinkside', 'Slalom Co', 'Spinlock Sports', 'Strikeline',
    'Tacklebox Nine', 'Topspin Lab', 'Varsity Row', 'Wicket & Co',
  ],
  audio: [
    'Amberton Audio', 'Ampersand Acoustics', 'Arcanum Audio', 'Auralin', 'Basswood Audio',
    'Beluga Acoustics', 'Cadenza Labs', 'Cantilever', 'Claro Audio', 'Crescendo Works',
    'Diaphragm Labs', 'Echoforge', 'Ferrous Audio', 'Grainline Audio', 'Harmonia',
    'Helicon Audio', 'Isoline', 'Kadence', 'Lumenaire Audio', 'Meridian Grove', 'Mica Acoustics',
    'Nocturne Audio', 'Oakline Audio', 'Octave Labs', 'Overtone Co', 'Phasewell',
    'Resonant Field', 'Sable Acoustics', 'Signal & Sound', 'Thrumwell', 'Timbre Lab',
    'Tonewood Co', 'Valve & Coil', 'Waveform Nine',
  ],
  gaming: [
    'Arcade Union', 'Axiom Play', 'Binary Fox', 'Bitcrush', 'Blockhaus Games', 'Cartridge Club',
    'Checkpoint Co', 'Circuit Bear', 'Console Row', 'Critline', 'Dicewell', 'Dropframe',
    'Eightbit Row', 'Framerate Labs', 'Frostbyte Gaming', 'Grindstone Games', 'Highscore Union',
    'Hitbox', 'Joystick Heritage', 'Levelcap', 'Loadout Labs', 'Meeple & Co', 'Nightcap Games',
    'Overclock Co', 'Pixelforge', 'Questline', 'Respawn Row', 'Rollcrit', 'Sidequest Supply',
    'Speedrun Supply', 'Tabletop Foundry', 'Twinstick', 'Vaultstone Games', 'Wireframe', 'Zonecap',
  ],
  books: [
    'Alder Press', 'Ampersand Paper', 'Antiquary Row', 'Belgrave Press', 'Blackletter',
    "Bookbinder's Row", 'Calliope Press', 'Cartridge & Quill', 'Clarendon House', 'Colophon',
    'Deckle & Edge', 'Ellsworth Press', 'Foliograph', 'Foxed Page', 'Gilded Margin',
    'Grosvenor Books', 'Inkwell Nine', 'Kestrel Press', 'Letterform Co', 'Linden Press',
    'Marginalia', 'Nib & Feather', 'Octavo', 'Paperwell', 'Parchment Row', 'Quire & Co',
    'Ravenstone Press', 'Ruled & Plain', 'Scriptorium', 'Signature Press', 'Thornfield Books',
    'Tidewater Press', 'Vellum & Vine', 'Whitleaf', 'Woodgrain Paper',
  ],
  art: [
    'Ashgate Editions', 'Atelier Vray', 'Aurum Numismatics', 'Belvedere Fine Art',
    'Bramwell Gallery', 'Cabinet Nine', 'Carbon Press Editions', 'Chroma Editions',
    'Claremont Auctions', 'Cobalt Gallery', 'Deacon & Fell', 'Editions Nord', 'Ferrier & Blake',
    'Gilt Frame', 'Halcyon Editions', 'Hollow Press', 'Kestrel Fine Art', 'Lacuna Gallery',
    'Marbury Antiques', 'Merrivale Auctions', 'Mordant Press', 'Northgate Fine Art',
    'Obverse Numismatics', 'Philatelic Row', 'Pigment & Press', 'Quarto Editions',
    'Ravelin Gallery', 'Serpentine Studio', 'Stonecourt Antiques', 'Terracotta Row',
    'Thornbury Auctions', 'Umber Studio', 'Vermilion Press', 'Whitmore Fine Art', 'Wren Editions',
  ],
  photography: [
    'Apertura', 'Bellows & Co', 'Bokehworks', 'Calotype Lab', 'Chroma Optics', 'Cinefield',
    'Contrast Nine', 'Darkroom Row', 'Daylight Optics', 'Ektra Labs', 'Emulsion Co', 'Ferrotype',
    'Focal Row', 'Glasshouse Optics', 'Halide Lab', 'Hyperfocal', 'Irisline', 'Kelvin Optics',
    'Lensmith', 'Lumagraph', 'Meniscus Optics', 'Nodal Point', 'Opticron Nine', 'Parallax Gear',
    'Prism & Plate', 'Rangefield', 'Rodenstar', 'Shutterline', 'Silvergrain', 'Sunlit Optics',
    'Tessarine', 'Tripodex', 'Verso Optics', 'Zoneplate',
  ],
  auto: [
    'Apex Garage', 'Axleworks', 'Bearing & Brace', 'Blackrock Auto', 'Bracknell Motorsport',
    'Camshaft Co', 'Carbide Racing', 'Chicane', 'Cogline', 'Crankhouse', 'Dragline Motors',
    'Ductline', 'Falkner Motorsport', 'Gasket & Grease', 'Gravelpit Moto', 'Heelgrip',
    'Ironclad Motorworks', 'Kerbstone', 'Lambda Racing', 'Manifold Row', 'Nordring', 'Octane Row',
    'Piston & Pin', 'Quickshift', 'Redline Forge', 'Rotorwerk', 'Slipstream Auto', 'Sparkwell',
    'Tarmac Union', 'Throttlebody', 'Torquehaus', 'Vantage Motorsport', 'Wrenchworks', 'Yawline',
    'Zenith Garage',
  ],
  pets: [
    'Aquascape Nine', 'Barkwell', 'Bramble & Bone', 'Burrowell', 'Chewsmith', 'Clawmark',
    'Cottontail Co', 'Dander & Co', 'Fetchline', 'Fielding Pet Co', 'Finline Aquatics',
    'Furrow & Paw', 'Gundog Supply', 'Halter & Hound', 'Houndstooth Supply', 'Kibblewood',
    'Leash & Lark', 'Litterwell', 'Meadowpaw', 'Mewsline', 'Nestling Pet', 'Orchard Paws',
    'Pawfield', 'Purrstone', 'Quillfeather', 'Ramble & Roam', 'Rootsong Pet', 'Scruffwell',
    'Snoutline', 'Tailwind Pet', 'Thistlepaw', 'Trot & Treat', 'Whiskerworks', 'Wildbrook Pet',
    'Yardley Pet',
  ],
  kids: [
    'Acorn & Ivy', 'Babbling Brook', 'Bellamy Baby', 'Birchcot', 'Bramblewood Kids', 'Bundlewell',
    'Buttonwood', 'Cloudberry Kids', 'Cradleworks', 'Dandelion Row', 'Ducklington',
    'Fernbrook Kids', 'Gingham Lane', 'Hopscotch Co', 'Juniper Sprout', 'Kindling Kids',
    'Lullaby Lane', 'Meadowmint', 'Milkwood', 'Nestling Nine', 'Oakling', 'Pebble & Pine',
    'Pipsqueak Co', 'Quilted Fox', 'Rocking Horse Row', 'Sandbox Supply', 'Sprigg',
    'Starling Baby', 'Tadpole & Co', 'Tinytown', 'Toddlewell', 'Wanderpram', 'Wildflower Kids',
    'Wobblefoot', 'Yarnling',
  ],
};

/**
 * Explicit tiers for the brands whose positioning should be stable across the
 * whole catalog — a premium brand must not land in a budget price band in one
 * category and a premium one in another. Unlisted brands get a deterministic
 * hashed tier from `brandTier`, which is enough to spread the rest.
 */
export const BRAND_TIER: Record<string, BrandTier> = {
  // tech
  'Aurex': 'premium', 'Monolith': 'premium', 'Meridian Tech': 'premium',
  'Obsidian Peripherals': 'premium', 'Kestrel Systems': 'mid', 'Halcyon Micro': 'mid',
  'Voltaic': 'mid', 'Wayfinder Tech': 'mid', 'Nordbyte': 'budget', 'Hexon': 'budget',
  'Quanta Lane': 'budget', 'Skyward Micro': 'budget',
  // home
  'Ironclad Cookware': 'premium', 'Forge & Flame': 'premium', 'Cast & Copper': 'premium',
  'Hearthwell': 'mid', 'Stonemill': 'mid', 'Millstone': 'mid', 'Brightpan': 'budget',
  'Kettleford': 'budget', 'Saltbox Kitchen': 'budget',
  // furniture
  'Atelier Nord': 'premium', 'Dovetail Studio': 'premium', 'Nordhaus': 'premium',
  'Teakhouse': 'mid', 'Linden & Main': 'mid', 'Maple Row': 'mid', 'Habitat Nine': 'budget',
  'Pennant Home': 'budget', 'Sundry Studio': 'budget',
  // fashion (men)
  'Vesper Tailoring': 'premium', 'Winslow & Grey': 'premium', 'Abbott & Drake': 'premium',
  'Mercer & Clay': 'mid', 'Norwood Standard': 'mid', 'Eastgate Supply': 'mid',
  'Quarterdeck': 'budget', 'Yarrow Co': 'budget', 'Broadcloth': 'budget',
  // fashion (women)
  'Maison Verre': 'premium', 'Belmont Atelier': 'premium', 'Yves & Marlow': 'premium',
  'Juno Atelier': 'mid', 'Aster & Vine': 'mid', 'Clove & Willow': 'mid', 'Lilou': 'budget',
  'Calla': 'budget', 'Plume': 'budget',
  // sneakers and streetwear
  'Deadstock Society': 'premium', 'Kinetic Form': 'premium', 'Nocturne Athletics': 'premium',
  'Marathon Standard': 'mid', 'Cadence Athletics': 'mid', 'Stride Lab': 'mid',
  'Pavement': 'budget', 'Warmup': 'budget', 'Overrun': 'budget',
  // watches and jewelry
  'Lumière Atelier': 'premium', 'Girard Noir': 'premium', 'Jourdain': 'premium',
  'Aurelia Fine': 'premium', 'Chronoform': 'mid', 'Corvus Watch Co': 'mid', 'Halbrand': 'mid',
  'Fathomwell': 'budget', 'Heimdall': 'budget', 'Nordfjord': 'budget',
  // beauty
  'Lumeire': 'premium', 'Hinoki Lab': 'premium', 'Quiet Ritual': 'premium',
  'Meridian Skin': 'mid', 'Aster Botanics': 'mid', 'Juniper Skin': 'mid', 'Clearfield': 'budget',
  'Flora Nine': 'budget', 'Terra Nine': 'budget',
  // fitness and outdoors
  'Pinnacle Forge': 'premium', 'Backcountry Forge': 'premium', 'Alpenglow': 'premium',
  'Ridgeline Co': 'mid', 'Northwind Gear': 'mid', 'Cascade Range': 'mid', 'Scree': 'budget',
  'Basecamp Nine': 'budget', 'Treeline Nine': 'budget',
  // sports
  'Topspin Lab': 'premium', 'Fairway Forge': 'premium', 'Powerline Sports': 'mid',
  'Matchpoint': 'mid', 'Reelcraft': 'mid', 'Halfcourt': 'budget', 'Nettle Sports': 'budget',
  'Varsity Row': 'budget',
  // audio
  'Arcanum Audio': 'premium', 'Valve & Coil': 'premium', 'Resonant Field': 'premium',
  'Cadenza Labs': 'mid', 'Timbre Lab': 'mid', 'Octave Labs': 'mid', 'Isoline': 'budget',
  'Waveform Nine': 'budget', 'Phasewell': 'budget',
  // gaming
  'Vaultstone Games': 'premium', 'Loadout Labs': 'premium', 'Framerate Labs': 'mid',
  'Respawn Row': 'mid', 'Tabletop Foundry': 'mid', 'Bitcrush': 'budget', 'Twinstick': 'budget',
  'Zonecap': 'budget',
  // books and stationery
  'Clarendon House': 'premium', 'Scriptorium': 'premium', 'Nib & Feather': 'premium',
  'Linden Press': 'mid', 'Letterform Co': 'mid', 'Quire & Co': 'mid', 'Ruled & Plain': 'budget',
  'Paperwell': 'budget', 'Woodgrain Paper': 'budget',
  // art and collectibles
  'Belvedere Fine Art': 'premium', 'Whitmore Fine Art': 'premium', 'Claremont Auctions': 'premium',
  'Chroma Editions': 'mid', 'Halcyon Editions': 'mid', 'Serpentine Studio': 'mid',
  'Pigment & Press': 'budget', 'Umber Studio': 'budget', 'Hollow Press': 'budget',
  // photography
  'Rodenstar': 'premium', 'Glasshouse Optics': 'premium', 'Meniscus Optics': 'premium',
  'Focal Row': 'mid', 'Kelvin Optics': 'mid', 'Parallax Gear': 'mid', 'Tripodex': 'budget',
  'Contrast Nine': 'budget', 'Irisline': 'budget',
  // auto and moto
  'Carbide Racing': 'premium', 'Rotorwerk': 'premium', 'Vantage Motorsport': 'premium',
  'Redline Forge': 'mid', 'Torquehaus': 'mid', 'Tarmac Union': 'mid', 'Kerbstone': 'budget',
  'Cogline': 'budget', 'Yawline': 'budget',
  // pets
  'Houndstooth Supply': 'premium', 'Rootsong Pet': 'premium', 'Meadowpaw': 'mid',
  'Leash & Lark': 'mid', 'Whiskerworks': 'mid', 'Chewsmith': 'budget', 'Fetchline': 'budget',
  'Litterwell': 'budget',
  // kids and baby
  'Wanderpram': 'premium', 'Cradleworks': 'premium', 'Bellamy Baby': 'mid',
  'Fernbrook Kids': 'mid', 'Juniper Sprout': 'mid', 'Tinytown': 'budget', 'Sprigg': 'budget',
  'Wobblefoot': 'budget',
};

const TIER_ORDER: readonly BrandTier[] = ['budget', 'mid', 'premium'];

/**
 * Tier for any brand. Listed brands keep their curated tier; anything else gets
 * a stable hashed tier so an unlisted brand still prices consistently wherever
 * it appears. Weighted towards `mid` because most of a real catalog is.
 */
export function brandTier(brand: string): BrandTier {
  const listed = BRAND_TIER[brand];
  if (listed) return listed;
  const bucket = hashString(`brand-tier:${brand}`) % 10;
  if (bucket < 3) return 'budget';
  if (bucket < 8) return 'mid';
  return 'premium';
}

/** Numeric rank of a tier, for price interpolation in the seeder. */
export function brandTierRank(tier: BrandTier): number {
  return TIER_ORDER.indexOf(tier);
}

// ---------------------------------------------------------------------------
// Codenames and colours
// ---------------------------------------------------------------------------

/** Fills `{word}` in a model pattern. Short, pronounceable, category-neutral. */
export const MODEL_CODENAMES: string[] = [
  'Arbor', 'Archer', 'Ardent', 'Atlas', 'Aurora', 'Avalon', 'Axiom', 'Basalt', 'Beacon',
  'Bellwether', 'Birch', 'Bishop', 'Blackbird', 'Bluff', 'Bramble', 'Brio', 'Bronco', 'Cadence',
  'Cairn', 'Calder', 'Canyon', 'Cascade', 'Cedar', 'Cipher', 'Citadel', 'Clipper', 'Cobalt',
  'Comet', 'Compass', 'Corsair', 'Cove', 'Crestline', 'Crimson', 'Cypress', 'Dagger', 'Dart',
  'Dawnline', 'Delta', 'Drift', 'Dune', 'Echo', 'Eclipse', 'Elder', 'Ember', 'Equinox', 'Everest',
  'Falcon', 'Fathom', 'Fenwick', 'Ferrous', 'Flint', 'Forge', 'Foxtrot', 'Frontier', 'Gale',
  'Gambit', 'Garnet', 'Glacier', 'Glider', 'Granite', 'Grove', 'Halcyon', 'Harbour', 'Hawk',
  'Helix', 'Heron', 'Highland', 'Hollow', 'Horizon', 'Ibis', 'Icarus', 'Indigo', 'Ironside',
  'Jasper', 'Jetty', 'Juniper', 'Kestrel', 'Keystone', 'Kodiak', 'Lantern', 'Lark', 'Ledger',
  'Legacy', 'Levant', 'Lighthouse', 'Lumen', 'Lynx', 'Magnolia', 'Mainsail', 'Mallard', 'Marlin',
  'Maverick', 'Meadow', 'Meridian', 'Mesa', 'Meteor', 'Midway', 'Mirage', 'Monarch', 'Moraine',
  'Nimbus', 'Nocturne', 'Nomad', 'Northstar', 'Obsidian', 'Odyssey', 'Onyx', 'Orbit', 'Orchard',
  'Osprey', 'Outpost', 'Overland', 'Paragon', 'Parallax', 'Pathfinder', 'Pennant', 'Peregrine',
  'Phoenix', 'Pilot', 'Pinnacle', 'Pioneer', 'Prospect', 'Quarry', 'Quasar', 'Quiver', 'Rampart',
  'Ranger', 'Ravine', 'Redwood', 'Regent', 'Relay', 'Ridge', 'Rimrock', 'Ripple', 'Rogue', 'Rover',
  'Sable', 'Saffron', 'Sage', 'Sailcloth', 'Sandpiper', 'Sentinel', 'Sequoia', 'Shadowline',
  'Shoreline', 'Sierra', 'Signal', 'Silverline', 'Skyline', 'Slate', 'Solstice', 'Sparrow',
  'Spire', 'Stonecrop', 'Stratos', 'Summit', 'Sundial', 'Switchback', 'Talon', 'Tamarack',
  'Tempest', 'Terrace', 'Thistle', 'Thunderhead', 'Tidewater', 'Timber', 'Titan', 'Torrent',
  'Trailhead', 'Trident', 'Tundra', 'Vanguard', 'Vantage', 'Vector', 'Verdant', 'Vertex',
  'Vesper', 'Voyager', 'Waypoint', 'Westwind', 'Wildwood', 'Willow', 'Windrow', 'Woodland',
  'Yarrow', 'Zenith', 'Zephyr',
];

/** Fills `{color}`. Spans neutrals, naturals and saturated accents. */
export const COLORS: string[] = [
  'Jet Black', 'Matte Black', 'Obsidian', 'Graphite', 'Charcoal', 'Slate Grey', 'Gunmetal',
  'Silver', 'Platinum', 'Stone', 'Pearl White', 'Arctic White', 'Off-White', 'Bone', 'Ivory',
  'Cream', 'Oat', 'Sand', 'Natural', 'Taupe', 'Khaki', 'Olive Drab', 'Forest Green', 'Sage',
  'Moss', 'Seafoam', 'Teal', 'Petrol Blue', 'Navy', 'Midnight Blue', 'Cobalt', 'Sky Blue',
  'Powder Blue', 'Indigo', 'Lavender', 'Plum', 'Aubergine', 'Burgundy', 'Oxblood', 'Brick Red',
  'Crimson', 'Coral', 'Blush Pink', 'Dusty Rose', 'Terracotta', 'Rust', 'Amber', 'Mustard',
  'Ochre', 'Butter Yellow', 'Chocolate', 'Espresso', 'Walnut', 'Tan', 'Camel', 'Rose Gold',
  'Champagne', 'Brass', 'Copper', 'Clear',
];

// ---------------------------------------------------------------------------
// L2 profiles
// ---------------------------------------------------------------------------

/** `[key, unit, ...values]` — compact authoring form for a `SpecKeySpec`. */
type SpecTuple = [string, SpecUnit, ...string[]];

interface ProfileInput {
  /** `[min, max]` in USD minor units. */
  price: [number, number];
  specs: SpecTuple[];
  titles: TitleSetName;
  models: string[];
  /** `[new, secondhand, auction]`, summing to 1. */
  mix: [number, number, number];
  cond: ConditionMixName;
  /** `[meanRating, ratingSpread, typicalCount]`. */
  review: [number, number, number];
  themes: string[];
}

const profiles: Record<string, L2Profile> = {};

function group(l1: string, entries: Record<string, ProfileInput>): void {
  for (const [id, input] of Object.entries(entries)) {
    profiles[id] = {
      id,
      l1,
      priceRange: input.price,
      specKeys: input.specs.map(([key, unit, ...values]) => ({ key, unit, values })),
      titlePatterns: TITLE_SETS[input.titles],
      modelPatterns: input.models,
      sourceTypeMix: {
        new: input.mix[0],
        secondhand: input.mix[1],
        auction: input.mix[2],
      },
      conditionMix: CONDITION_MIXES[input.cond],
      reviewProfile: {
        meanRating: input.review[0],
        ratingSpread: input.review[1],
        typicalCount: input.review[2],
      },
      themes: input.themes,
    };
  }
}

// --- Tech and gadgets: model-number driven, heavy new share, fast depreciation.
group('tech', {
  keyboards: {
    price: [1900, 39900],
    specs: [
      ['switch_type', null, 'tactile', 'linear', 'clicky', 'silent tactile', 'hall effect'],
      ['layout', null, '60%', '65%', '75%', 'TKL', 'full-size', 'Alice', '40%'],
      ['connection', null, 'wired', 'bluetooth', '2.4ghz', 'tri-mode'],
      ['keycap_profile', null, 'Cherry', 'OEM', 'SA', 'XDA', 'MT3'],
      ['hot_swap', null, '5-pin hot-swap', '3-pin hot-swap', 'soldered'],
      ['weight', 'g', '680', '890', '1240', '1580', '2100'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{A}{N}-{A}', '{word} {A}{N}'],
    mix: [0.72, 0.25, 0.03],
    cond: 'electronics',
    review: [4.3, 0.7, 180],
    themes: ['build_quality', 'switch_feel', 'stabilizers', 'software', 'noise', 'value'],
  },
  laptops: {
    price: [14900, 349900],
    specs: [
      ['screen_size', 'in', '11', '13.3', '14', '15.6', '16'],
      ['memory', null, '8GB', '16GB', '24GB', '32GB', '64GB'],
      ['storage_capacity', null, '128GB', '256GB', '512GB', '1TB', '2TB'],
      ['battery_life', null, '8 h', '12 h', '16 h', '20 h'],
      ['weight', 'g', '980', '1240', '1680', '2100', '2600'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{A}{N}-{N}', '{word} Pro {N}'],
    mix: [0.62, 0.33, 0.05],
    cond: 'electronics',
    review: [4.2, 0.8, 340],
    themes: ['battery_life', 'build_quality', 'screen_quality', 'thermals', 'performance', 'noise'],
  },
  phones: {
    price: [900, 129900],
    specs: [
      ['compatibility', null, 'iPhone 15', 'iPhone 16', 'Galaxy S24', 'Pixel 9', 'universal'],
      ['material', null, 'TPU', 'polycarbonate', 'silicone', 'aramid fibre', 'full-grain leather'],
      ['drop_rating', null, '1.2 m', '2 m', '3 m', 'MIL-STD-810G'],
      ['output_power', 'W', '15', '20', '30', '45', '65'],
      ['magnet_type', null, 'MagSafe compatible', 'magnetic ring', 'none'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{word}', '{A}{N}{A}'],
    mix: [0.8, 0.18, 0.02],
    cond: 'electronics',
    review: [4.1, 0.9, 520],
    themes: ['fit_accuracy', 'drop_protection', 'grip', 'charging_speed', 'value', 'durability'],
  },
  wearables: {
    price: [2900, 89900],
    specs: [
      ['case_size', 'mm', '38', '40', '42', '44', '46'],
      ['display', null, 'AMOLED', 'LCD', 'MIP transflective', 'micro-LED'],
      ['battery_life', null, '18 h', '2 days', '7 days', '14 days'],
      ['water_rating', null, '5 ATM', '10 ATM', 'IP68'],
      ['sensors', null, 'heart rate', 'SpO2', 'ECG', 'GPS', 'skin temperature'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{word} {A}{N}', '{A}{N} Pro'],
    mix: [0.74, 0.24, 0.02],
    cond: 'electronics',
    review: [4.2, 0.8, 410],
    themes: ['battery_life', 'tracking_accuracy', 'comfort', 'app_experience', 'strap_quality'],
  },
  smarthome: {
    price: [1200, 89900],
    specs: [
      ['protocol', null, 'Wi-Fi', 'Zigbee', 'Z-Wave', 'Matter', 'Thread'],
      ['power_draw', 'W', '2', '5', '9', '15', '60'],
      ['brightness', null, '800 lm', '1100 lm', '1600 lm'],
      ['hub_required', null, 'hub required', 'no hub needed'],
      ['voice_assistant', null, 'Alexa', 'Google Home', 'Siri Shortcuts', 'none'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{word}', 'Mk{N}'],
    mix: [0.86, 0.13, 0.01],
    cond: 'electronics',
    review: [4.0, 0.9, 620],
    themes: ['setup_ease', 'app_experience', 'connectivity', 'reliability', 'privacy', 'value'],
  },
  storage: {
    price: [1500, 129900],
    specs: [
      ['capacity', null, '500GB', '1TB', '2TB', '4TB', '8TB'],
      ['interface', null, 'USB-C 10Gbps', 'USB 3.2 Gen 2x2', 'Thunderbolt 4', 'SATA III'],
      ['read_speed', null, '540 MB/s', '1050 MB/s', '2000 MB/s', '2800 MB/s'],
      ['wifi_standard', null, 'Wi-Fi 6', 'Wi-Fi 6E', 'Wi-Fi 7'],
      ['bays', null, '2-bay', '4-bay', '6-bay', '8-bay'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{A}{N}-{N}', '{word} {N}', '{A}{N}{A}'],
    mix: [0.82, 0.16, 0.02],
    cond: 'electronics',
    review: [4.3, 0.7, 290],
    themes: ['transfer_speed', 'reliability', 'heat', 'setup_ease', 'build_quality'],
  },
  pcparts: {
    price: [1900, 189900],
    specs: [
      ['memory_size', null, '8GB', '12GB', '16GB', '24GB', '32GB'],
      ['tdp', 'W', '65', '105', '170', '320', '450'],
      ['socket', null, 'AM5', 'AM4', 'LGA1700', 'LGA1851'],
      ['form_factor', null, 'ATX', 'micro-ATX', 'mini-ITX', 'E-ATX'],
      ['memory_speed', null, 'DDR4-3600', 'DDR5-5600', 'DDR5-6000', 'DDR5-6400'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{A}{N}-{A}', '{A}{N} {A}{N}', '{word} {N}'],
    mix: [0.68, 0.29, 0.03],
    cond: 'electronics',
    review: [4.4, 0.7, 230],
    themes: ['performance', 'thermals', 'noise', 'build_quality', 'compatibility', 'value'],
  },
  monitors: {
    price: [7900, 229900],
    specs: [
      ['panel_size', 'in', '24', '27', '32', '34', '49'],
      ['refresh_rate', 'Hz', '60', '120', '144', '165', '240'],
      ['panel_type', null, 'IPS', 'VA', 'OLED', 'TN'],
      ['resolution', null, '1920x1080', '2560x1440', '3440x1440', '3840x2160'],
      ['response_time', null, '1 ms', '3 ms', '5 ms'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{A}{N}{A}', '{word} {N}', '{A}{N}-{N}'],
    mix: [0.74, 0.23, 0.03],
    cond: 'electronics',
    review: [4.2, 0.8, 310],
    themes: ['colour_accuracy', 'backlight_bleed', 'stand_quality', 'packaging', 'value'],
  },
  drones: {
    price: [2900, 299900],
    specs: [
      ['flight_time', null, '18 min', '28 min', '34 min', '46 min'],
      ['camera', null, '1/1.3" CMOS', '4K60', '5.4K', '8K'],
      ['takeoff_weight', 'g', '249', '595', '900', '1375'],
      ['range', null, '6 km', '10 km', '15 km', '20 km'],
      ['gimbal_axes', null, '2-axis', '3-axis', 'none'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{A}{N} Pro', '{word} {A}{N}'],
    mix: [0.7, 0.27, 0.03],
    cond: 'electronics',
    review: [4.1, 0.9, 160],
    themes: ['flight_stability', 'battery_life', 'video_quality', 'range', 'durability'],
  },
  diyelectronics: {
    price: [900, 149900],
    specs: [
      ['mcu', null, 'RP2040', 'ESP32-S3', 'ATmega328P', 'STM32F4', 'nRF52840'],
      ['io_pins', null, '20', '26', '40', '54'],
      ['bandwidth', null, '20 MHz', '100 MHz', '200 MHz', '350 MHz'],
      ['supply_voltage', null, '3.3 V', '5 V', '12 V', '24 V'],
      ['build_volume', 'mm', '220x220x250', '256x256x256', '300x300x400'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{A}{N}{A}', '{word} {N}', 'Mk{N}'],
    mix: [0.79, 0.19, 0.02],
    cond: 'electronics',
    review: [4.3, 0.8, 140],
    themes: ['documentation', 'build_quality', 'accuracy', 'ease_of_use', 'value'],
  },
});

// --- Home and kitchen: durable goods, mostly bought new, material-led titles.
group('home', {
  cookware: {
    price: [2900, 49900],
    specs: [
      ['material', null, 'cast iron', 'carbon steel', '5-ply stainless', 'hard-anodised aluminium', 'enamelled cast iron'],
      ['diameter', 'cm', '20', '24', '26', '28', '30'],
      ['weight', 'g', '900', '1400', '2100', '3200', '4600'],
      ['oven_safe', null, '230 C', '260 C', '290 C'],
      ['handle', null, 'riveted stainless', 'cast iron loop', 'wooden', 'silicone-wrapped'],
    ],
    titles: 'homegoods',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.88, 0.1, 0.02],
    cond: 'gently',
    review: [4.4, 0.7, 420],
    themes: ['heat_distribution', 'seasoning', 'weight', 'handle_comfort', 'cleaning', 'durability'],
  },
  knives: {
    price: [1900, 59900],
    specs: [
      ['steel', null, 'VG-10', 'AUS-8', '52100 carbon', 'SG2 powder steel', 'X50CrMoV15'],
      ['blade_length', 'mm', '85', '150', '180', '210', '240'],
      ['hardness', null, '58 HRC', '60 HRC', '61 HRC', '63 HRC'],
      ['handle_material', null, 'pakkawood', 'micarta', 'G10', 'POM', 'olive wood'],
      ['grind', null, 'double bevel', 'single bevel', 'convex'],
    ],
    titles: 'homegoods',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.86, 0.11, 0.03],
    cond: 'gently',
    review: [4.5, 0.6, 380],
    themes: ['edge_retention', 'sharpness_out_of_box', 'handle_comfort', 'balance', 'fit_and_finish'],
  },
  coffee: {
    price: [1900, 349900],
    specs: [
      ['pressure', null, '9 bar', '15 bar', '20 bar'],
      ['boiler_type', null, 'single boiler', 'heat exchanger', 'dual boiler', 'thermoblock'],
      ['grind_settings', null, '15 steps', '40 steps', '60 clicks', 'stepless'],
      ['capacity', 'ml', '300', '600', '1000', '1700'],
      ['burr_type', null, 'conical steel', 'flat steel', 'ceramic conical'],
      ['power', 'W', '800', '1200', '1450', '1800'],
    ],
    titles: 'homegoods',
    models: ['{word} {N}', '{A}{N}', 'Mk{N}', '{word} Pro'],
    mix: [0.8, 0.17, 0.03],
    cond: 'gently',
    review: [4.3, 0.8, 510],
    themes: ['temperature_stability', 'grind_consistency', 'build_quality', 'ease_of_use', 'cleaning', 'noise'],
  },
  smallappliance: {
    price: [2900, 89900],
    specs: [
      ['capacity', 'L', '1.7', '3.5', '5.7', '8'],
      ['power', 'W', '700', '1000', '1500', '1800'],
      ['speeds', null, '3 speeds', '5 speeds', '10 speeds', 'variable'],
      ['material', null, 'die-cast metal', 'stainless steel', 'BPA-free plastic'],
      ['programs', null, '6 presets', '8 presets', '12 presets'],
    ],
    titles: 'homegoods',
    models: ['{word} {N}', '{A}{N}', '{word} {A}{N}'],
    mix: [0.87, 0.11, 0.02],
    cond: 'gently',
    review: [4.2, 0.9, 760],
    themes: ['ease_of_use', 'noise', 'capacity', 'cleaning', 'durability', 'value'],
  },
  tableware: {
    price: [1200, 39900],
    specs: [
      ['material', null, 'stoneware', 'porcelain', 'bone china', 'borosilicate glass', 'stainless steel'],
      ['set_size', null, '4-piece', '8-piece', '12-piece', '16-piece'],
      ['capacity', 'ml', '250', '350', '450', '600'],
      ['finish', null, 'matte glaze', 'reactive glaze', 'speckled', 'gloss'],
      ['dishwasher_safe', null, 'dishwasher safe', 'hand wash only'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.83, 0.13, 0.04],
    cond: 'gently',
    review: [4.3, 0.8, 290],
    themes: ['finish_quality', 'chip_resistance', 'weight', 'packaging', 'colour_accuracy'],
  },
  storagekitchen: {
    price: [900, 24900],
    specs: [
      ['material', null, 'borosilicate glass', 'BPA-free plastic', 'stainless steel', 'bamboo'],
      ['capacity', 'ml', '500', '1000', '1800', '3000'],
      ['seal_type', null, 'silicone gasket', 'clip-lock', 'screw lid', 'vacuum'],
      ['set_size', null, '3-piece', '6-piece', '10-piece', '14-piece'],
      ['stackable', null, 'stackable', 'nesting', 'fixed'],
    ],
    titles: 'homegoods',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.9, 0.08, 0.02],
    cond: 'gently',
    review: [4.1, 0.9, 480],
    themes: ['seal_quality', 'capacity', 'cleaning', 'durability', 'value'],
  },
  bedding: {
    price: [3900, 89900],
    specs: [
      ['material', null, 'long-staple cotton', 'French linen', 'bamboo viscose', 'Tencel lyocell'],
      ['weave', null, 'percale', 'sateen', 'jersey', 'flannel'],
      ['thread_count', null, '200', '300', '400', '600'],
      ['fill_power', null, '650', '700', '800'],
      ['size', null, 'Twin', 'Full', 'Queen', 'King', 'Cal King'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.9, 0.09, 0.01],
    cond: 'nearNew',
    review: [4.2, 0.9, 640],
    themes: ['softness', 'breathability', 'shrinkage', 'colour_accuracy', 'durability'],
  },
  bath: {
    price: [1200, 29900],
    specs: [
      ['material', null, 'Turkish cotton', 'Egyptian cotton', 'bamboo blend', 'microfibre', 'waffle weave'],
      ['weight', 'g', '400', '500', '600', '700'],
      ['finish', null, 'brushed nickel', 'matte black', 'chrome', 'brushed brass'],
      ['flow_rate', null, '1.8 gpm', '2.0 gpm', '2.5 gpm'],
      ['size', 'cm', '50x90', '70x140', '90x150'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{A}{N}', '{word} {N}'],
    mix: [0.9, 0.08, 0.02],
    cond: 'nearNew',
    review: [4.2, 0.8, 350],
    themes: ['absorbency', 'softness', 'durability', 'colour_accuracy', 'installation'],
  },
  cleaning: {
    price: [2900, 99900],
    specs: [
      ['suction', null, '120 AW', '185 AW', '230 AW'],
      ['runtime', null, '30 min', '45 min', '60 min', '90 min'],
      ['filtration', null, 'HEPA H13', 'HEPA H14', 'carbon + HEPA'],
      ['coverage', null, '300 sq ft', '600 sq ft', '1000 sq ft'],
      ['tank_capacity', 'ml', '400', '800', '2500', '4500'],
    ],
    titles: 'homegoods',
    models: ['{word} {N}', '{A}{N}', '{word} Pro'],
    mix: [0.88, 0.11, 0.01],
    cond: 'electronics',
    review: [4.1, 0.9, 720],
    themes: ['suction_power', 'battery_life', 'noise', 'filter_cost', 'ease_of_use', 'durability'],
  },
  hometools: {
    price: [1900, 69900],
    specs: [
      ['voltage', null, '12 V', '18 V', '20 V max', '36 V'],
      ['torque', null, '35 Nm', '60 Nm', '90 Nm', '120 Nm'],
      ['chuck_size', 'mm', '10', '13'],
      ['battery', null, '2.0 Ah', '4.0 Ah', '5.0 Ah', '8.0 Ah'],
      ['set_size', null, '40-piece', '108-piece', '210-piece'],
    ],
    titles: 'homegoods',
    models: ['{A}{N}', '{word} {N}', '{A}{N}-{N}'],
    mix: [0.8, 0.18, 0.02],
    cond: 'hardUse',
    review: [4.4, 0.7, 410],
    themes: ['build_quality', 'battery_life', 'torque', 'ergonomics', 'case_quality', 'value'],
  },
});

// --- Furniture and decor: high ticket, bulky shipping, a real vintage resale tail.
group('furniture', {
  seating: {
    price: [14900, 549900],
    specs: [
      ['upholstery', null, 'full-grain leather', 'bouclé', 'performance velvet', 'linen weave', 'top-grain leather'],
      ['seats', null, '1-seat', '2-seat', '3-seat', '4-seat', 'corner'],
      ['width', 'cm', '80', '150', '200', '250', '300'],
      ['frame', null, 'kiln-dried hardwood', 'solid oak', 'powder-coated steel', 'walnut'],
      ['fill', null, 'feather-down', 'high-resilience foam', 'pocket spring'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.72, 0.25, 0.03],
    cond: 'gently',
    review: [4.2, 0.8, 190],
    themes: ['comfort', 'assembly', 'upholstery_quality', 'firmness', 'delivery', 'colour_accuracy'],
  },
  desks: {
    price: [9900, 249900],
    specs: [
      ['width', 'cm', '100', '120', '140', '160', '180'],
      ['height_range', 'cm', '60-125', '65-130', '72 fixed'],
      ['material', null, 'solid oak', 'walnut veneer', 'bamboo', 'powder-coated steel', 'laminate'],
      ['weight_capacity', null, '80 kg', '125 kg', '150 kg'],
      ['adjustment', null, 'dual motor', 'single motor', 'hand crank', 'fixed height'],
    ],
    titles: 'homegoods',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.76, 0.22, 0.02],
    cond: 'gently',
    review: [4.3, 0.8, 260],
    themes: ['stability', 'assembly', 'motor_noise', 'build_quality', 'surface_finish', 'value'],
  },
  tables: {
    price: [9900, 399900],
    specs: [
      ['length', 'cm', '90', '120', '160', '200', '240'],
      ['material', null, 'solid walnut', 'white oak', 'Carrara marble', 'tempered glass', 'travertine'],
      ['seats', null, '2', '4', '6', '8', '10'],
      ['finish', null, 'hardwax oiled', 'lacquered', 'matte', 'raw'],
      ['base', null, 'pedestal', 'trestle', 'four-leg', 'hairpin'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.7, 0.26, 0.04],
    cond: 'gently',
    review: [4.3, 0.8, 150],
    themes: ['surface_finish', 'stability', 'assembly', 'delivery', 'size_accuracy', 'colour_accuracy'],
  },
  storagefurniture: {
    price: [7900, 299900],
    specs: [
      ['width', 'cm', '60', '80', '120', '180', '240'],
      ['material', null, 'solid ash', 'oak veneer', 'laminated MDF', 'rattan', 'powder-coated steel'],
      ['shelves', null, '3', '4', '5', '6'],
      ['doors', null, '2 doors', '3 doors', 'sliding', 'open front'],
      ['weight_capacity', null, '15 kg per shelf', '25 kg per shelf', '40 kg per shelf'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.74, 0.23, 0.03],
    cond: 'gently',
    review: [4.2, 0.8, 180],
    themes: ['assembly', 'build_quality', 'drawer_action', 'surface_finish', 'delivery', 'value'],
  },
  beds: {
    price: [19900, 449900],
    specs: [
      ['size', null, 'Twin', 'Full', 'Queen', 'King', 'Cal King'],
      ['material', null, 'solid oak', 'upholstered linen', 'bouclé', 'powder-coated steel', 'walnut'],
      ['height', 'cm', '25', '35', '45'],
      ['firmness', null, 'soft', 'medium', 'medium-firm', 'firm'],
      ['slat_spacing', 'cm', '6', '8', '10'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.82, 0.16, 0.02],
    cond: 'gently',
    review: [4.2, 0.9, 240],
    themes: ['comfort', 'assembly', 'firmness', 'noise', 'delivery', 'durability'],
  },
  lighting: {
    price: [3900, 179900],
    specs: [
      ['bulb_type', null, 'E26', 'E27', 'GU10', 'integrated LED'],
      ['power', 'W', '6', '9', '12', '18', '40'],
      ['colour_temperature', null, '2200K', '2700K', '3000K', '4000K'],
      ['material', null, 'brushed brass', 'blackened steel', 'opal glass', 'linen shade', 'alabaster'],
      ['dimmable', null, 'dimmable', 'app-dimmable', 'not dimmable'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.83, 0.14, 0.03],
    cond: 'gently',
    review: [4.2, 0.8, 220],
    themes: ['light_quality', 'build_quality', 'installation', 'dimming', 'colour_accuracy'],
  },
  rugs: {
    // Vintage and antique rugs trade hand-to-hand and at auction far more than
    // the rest of the L1, which is why the secondhand share is double.
    price: [4900, 249900],
    specs: [
      ['material', null, 'hand-knotted wool', 'jute', 'viscose blend', 'cotton flatweave', 'polypropylene'],
      ['size', null, '2x6 ft runner', '5x8 ft', '8x10 ft', '9x12 ft'],
      ['pile_height', 'mm', '4', '10', '18', '30'],
      ['weave', null, 'hand-knotted', 'hand-tufted', 'flatwoven', 'machine-woven'],
      ['origin', null, 'Turkey', 'India', 'Morocco', 'Nepal', 'Belgium'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.66, 0.28, 0.06],
    cond: 'vintage',
    review: [4.2, 0.9, 170],
    themes: ['colour_accuracy', 'pile_quality', 'shedding', 'size_accuracy', 'odour', 'value'],
  },
  wallart: {
    price: [1900, 129900],
    specs: [
      ['size', null, '8x10 in', '18x24 in', '24x36 in', '30x40 in'],
      ['medium', null, 'giclée on cotton rag', 'offset lithograph', 'stretched canvas', 'archival pigment'],
      ['frame', null, 'unframed', 'oak frame', 'black metal frame', 'walnut float frame'],
      ['edition', null, 'open edition', 'edition of 50', 'edition of 100', 'artist proof'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.7, 0.2, 0.1],
    cond: 'gently',
    review: [4.3, 0.8, 120],
    themes: ['print_quality', 'colour_accuracy', 'framing', 'packaging', 'size_accuracy'],
  },
  plants: {
    price: [1200, 39900],
    specs: [
      ['pot_diameter', 'cm', '10', '14', '18', '24', '30'],
      ['height', 'cm', '20', '45', '80', '120'],
      ['light_needs', null, 'low light', 'bright indirect', 'full sun'],
      ['material', null, 'terracotta', 'glazed stoneware', 'fibre-clay', 'recycled plastic'],
      ['drainage', null, 'drainage hole', 'no drainage hole', 'self-watering'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.9, 0.08, 0.02],
    cond: 'gently',
    review: [4.1, 1.0, 240],
    themes: ['plant_health', 'packaging', 'size_accuracy', 'drainage', 'delivery', 'value'],
  },
  outdoorfurniture: {
    price: [7900, 349900],
    specs: [
      ['material', null, 'powder-coated aluminium', 'teak', 'acacia', 'all-weather wicker', 'galvanised steel'],
      ['seats', null, '2', '4', '6', '8'],
      ['weather_rating', null, 'UV-stable', 'rust-resistant', 'marine-grade'],
      ['cushion_fabric', null, 'Olefin', 'solution-dyed acrylic', 'polyester canvas'],
      ['width', 'cm', '70', '140', '200', '260'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.84, 0.14, 0.02],
    cond: 'hardUse',
    review: [4.1, 0.9, 160],
    themes: ['weather_resistance', 'assembly', 'comfort', 'build_quality', 'delivery'],
  },
});

// --- Fashion (men): size and fabric are the whole spec sheet; resale is healthy.
group('fashion-men', {
  mentops: {
    price: [2900, 34900],
    specs: [
      ['size', null, 'XS', 'S', 'M', 'L', 'XL', 'XXL'],
      ['fabric', null, 'combed cotton', 'Supima cotton', 'merino wool', 'cotton-linen', 'French terry'],
      ['fit', null, 'slim', 'regular', 'relaxed', 'boxy'],
      ['fabric_weight', null, '140 gsm', '180 gsm', '220 gsm', '320 gsm'],
      ['origin', null, 'Portugal', 'Japan', 'Italy', 'Peru'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.62, 0.36, 0.02],
    cond: 'apparel',
    review: [4.2, 0.8, 210],
    themes: ['sizing', 'fabric_quality', 'shrinkage', 'colour_accuracy', 'stitching', 'value'],
  },
  menouterwear: {
    price: [7900, 189900],
    specs: [
      ['fill', null, '700 fill down', '800 fill down', 'PrimaLoft', 'wool wadding'],
      ['shell', null, 'waxed cotton', '60/40 cloth', 'Ventile', 'Horween leather', 'recycled nylon'],
      ['waterproofing', null, 'DWR finish', '10k mm', '20k mm', 'fully taped seams'],
      ['fit', null, 'slim', 'regular', 'relaxed'],
      ['size', null, 'S', 'M', 'L', 'XL', 'XXL'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.58, 0.39, 0.03],
    cond: 'apparel',
    review: [4.3, 0.8, 180],
    themes: ['warmth', 'sizing', 'weather_resistance', 'hardware_quality', 'fabric_quality', 'stitching'],
  },
  menbottoms: {
    price: [4900, 39900],
    specs: [
      ['waist', null, '28', '30', '32', '34', '36', '38'],
      ['inseam', null, '30', '32', '34'],
      ['fabric', null, '14oz selvedge denim', '21oz denim', 'cotton twill', 'tropical wool', 'corduroy'],
      ['fit', null, 'slim', 'straight', 'tapered', 'wide'],
      ['rise', null, 'low rise', 'mid rise', 'high rise'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.6, 0.38, 0.02],
    cond: 'apparel',
    review: [4.2, 0.8, 230],
    themes: ['sizing', 'fabric_quality', 'fade_quality', 'stitching', 'comfort', 'shrinkage'],
  },
  mentailoring: {
    price: [9900, 249900],
    specs: [
      ['fabric', null, 'Super 110s wool', 'Super 150s wool', 'fresco wool', 'Irish linen', 'flannel'],
      ['canvas', null, 'full canvas', 'half canvas', 'fused'],
      ['size', null, '38R', '40R', '42R', '44L', '46R'],
      ['lapel', null, 'notch', 'peak', 'shawl'],
      ['buttons', null, 'two-button', 'three-roll-two', 'double-breasted'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.6, 0.36, 0.04],
    cond: 'apparel',
    review: [4.3, 0.8, 120],
    themes: ['sizing', 'fabric_quality', 'tailoring_quality', 'lining', 'stitching', 'value'],
  },
  menshoes: {
    price: [6900, 89900],
    specs: [
      ['size', null, 'UK 7', 'UK 8', 'UK 9', 'US 9', 'US 10', 'EU 43'],
      ['construction', null, 'Goodyear welted', 'Blake stitched', 'cemented', 'Norwegian welt'],
      ['leather', null, 'calfskin', 'suede', 'shell cordovan', 'pebble grain'],
      ['last', null, 'round toe', 'chisel toe', 'almond toe'],
      ['sole', null, 'leather sole', 'Dainite', 'commando', 'crepe'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.62, 0.35, 0.03],
    cond: 'apparel',
    review: [4.3, 0.8, 190],
    themes: ['sizing', 'comfort', 'break_in', 'leather_quality', 'resoleability', 'durability'],
  },
  menaccessories: {
    price: [1900, 39900],
    specs: [
      ['material', null, 'full-grain leather', 'bridle leather', 'cashmere', 'lambswool', 'acetate'],
      ['width', 'mm', '30', '32', '35', '38'],
      ['lens', null, 'polarised', 'G15', 'brown gradient', 'photochromic'],
      ['closure', null, 'pin buckle', 'single-prong', 'magnetic'],
      ['size', null, 'One size', 'S/M', 'L/XL'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.7, 0.28, 0.02],
    cond: 'apparel',
    review: [4.2, 0.8, 240],
    themes: ['leather_quality', 'hardware_quality', 'sizing', 'colour_accuracy', 'durability'],
  },
  menbags: {
    price: [4900, 129900],
    specs: [
      ['capacity', 'L', '8', '16', '22', '30', '45'],
      ['material', null, '1000D Cordura', 'waxed canvas', 'full-grain leather', 'X-Pac', 'ballistic nylon'],
      ['laptop_fit', 'in', '13', '14', '15', '16'],
      ['closure', null, 'zip', 'roll-top', 'buckle flap', 'magnetic'],
      ['carry', null, 'shoulder', 'backpack', 'hand carry', 'convertible'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.68, 0.29, 0.03],
    cond: 'apparel',
    review: [4.3, 0.8, 200],
    themes: ['capacity', 'hardware_quality', 'comfort', 'organisation', 'durability', 'weight'],
  },
  menbasics: {
    // Hygiene category: resale is negligible and what exists is unworn stock.
    price: [1200, 12900],
    specs: [
      ['size', null, 'S', 'M', 'L', 'XL', 'XXL'],
      ['fabric', null, 'modal blend', 'Supima cotton', 'merino wool', 'bamboo viscose'],
      ['pack_size', null, 'single', '3-pack', '5-pack'],
      ['inseam', 'in', '3', '6', '9'],
      ['cushioning', null, 'no cushion', 'light cushion', 'full cushion'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.88, 0.11, 0.01],
    cond: 'nearNew',
    review: [4.2, 0.9, 520],
    themes: ['comfort', 'sizing', 'fabric_quality', 'durability', 'value'],
  },
  menworkwear: {
    price: [3900, 49900],
    specs: [
      ['fabric', null, '12oz duck canvas', '8.5oz chambray', '14oz denim', 'ripstop cotton'],
      ['fit', null, 'regular', 'relaxed', 'loose'],
      ['size', null, 'S', 'M', 'L', 'XL', 'XXL'],
      ['pockets', null, '4 pockets', '6 pockets', '8 pockets'],
      ['reinforcement', null, 'triple-stitched', 'bar-tacked', 'riveted'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.7, 0.28, 0.02],
    cond: 'hardUse',
    review: [4.4, 0.7, 260],
    themes: ['durability', 'sizing', 'fabric_quality', 'pockets', 'stitching', 'comfort'],
  },
  menvintage: {
    // By definition there is no new stock: everything here is resale, and the
    // scarce pieces are consigned to auction rather than priced outright.
    price: [3900, 149900],
    specs: [
      ['era', null, '1950s', '1960s', '1970s', '1980s', '1990s'],
      ['size', null, 'S', 'M', 'L', 'XL'],
      ['fabric', null, 'sanforized denim', 'wool melton', 'cotton sateen', 'jersey'],
      ['flaws', null, 'none noted', 'light fading', 'small repair', 'moth nips'],
      ['provenance', null, 'US-made', 'Japan-made', 'military issue', 'deadstock'],
    ],
    titles: 'lot',
    models: ['{word}', '{N}s {word}', '{A}{N}'],
    mix: [0.04, 0.78, 0.18],
    cond: 'vintage',
    review: [4.1, 1.0, 45],
    themes: ['condition_accuracy', 'sizing', 'authenticity', 'fabric_quality', 'odour', 'value'],
  },
});

// --- Fashion (women): size systems vary by brand, so sizing dominates reviews.
group('fashion-women', {
  womendresses: {
    price: [4900, 129900],
    specs: [
      ['size', null, 'US 0', 'US 2', 'US 4', 'US 6', 'US 8', 'US 10', 'US 12'],
      ['fabric', null, 'silk crepe de chine', 'viscose', 'cotton poplin', 'Belgian linen', 'ponte knit'],
      ['length', null, 'mini', 'midi', 'maxi'],
      ['lining', null, 'fully lined', 'half lined', 'unlined'],
      ['closure', null, 'invisible zip', 'button front', 'wrap tie'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.66, 0.31, 0.03],
    cond: 'apparel',
    review: [4.2, 0.9, 260],
    themes: ['sizing', 'fabric_quality', 'colour_accuracy', 'lining', 'drape', 'stitching'],
  },
  womentops: {
    price: [2900, 49900],
    specs: [
      ['size', null, 'XS', 'S', 'M', 'L', 'XL'],
      ['fabric', null, 'silk charmeuse', 'cotton poplin', 'merino wool', 'cashmere blend', 'modal'],
      ['fit', null, 'fitted', 'relaxed', 'oversized'],
      ['sleeve', null, 'sleeveless', 'short sleeve', 'long sleeve', 'puff sleeve'],
      ['neckline', null, 'crew', 'v-neck', 'scoop', 'boat'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.68, 0.3, 0.02],
    cond: 'apparel',
    review: [4.1, 0.9, 290],
    themes: ['sizing', 'fabric_quality', 'sheerness', 'colour_accuracy', 'stitching', 'value'],
  },
  womenbottoms: {
    price: [3900, 49900],
    specs: [
      ['size', null, 'US 24', 'US 26', 'US 28', 'US 30', 'US 32'],
      ['fabric', null, 'rigid denim', 'stretch denim', 'wool suiting', 'Tencel twill', 'ponte'],
      ['rise', null, 'low rise', 'mid rise', 'high rise'],
      ['leg', null, 'skinny', 'straight', 'wide leg', 'flare'],
      ['inseam', 'in', '26', '28', '30', '32'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.66, 0.32, 0.02],
    cond: 'apparel',
    review: [4.1, 0.9, 310],
    themes: ['sizing', 'stretch_recovery', 'fabric_quality', 'rise_accuracy', 'colour_accuracy', 'comfort'],
  },
  womenouterwear: {
    price: [7900, 249900],
    specs: [
      ['fabric', null, 'double-face wool', 'cashmere blend', 'cotton gabardine', 'recycled nylon', 'shearling'],
      ['fill', null, '700 fill down', 'recycled polyfill', 'wool wadding'],
      ['length', null, 'cropped', 'hip length', 'knee length', 'full length'],
      ['size', null, 'XS', 'S', 'M', 'L', 'XL'],
      ['lining', null, 'cupro lining', 'quilted lining', 'unlined'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.6, 0.37, 0.03],
    cond: 'apparel',
    review: [4.3, 0.8, 170],
    themes: ['warmth', 'sizing', 'fabric_quality', 'hardware_quality', 'drape', 'stitching'],
  },
  womenshoes: {
    price: [5900, 129900],
    specs: [
      ['size', null, 'EU 36', 'EU 37', 'EU 38', 'EU 39', 'EU 40', 'US 8'],
      ['heel_height', 'mm', '0', '25', '55', '85', '100'],
      ['material', null, 'nappa leather', 'suede', 'patent leather', 'raffia', 'recycled mesh'],
      ['sole', null, 'leather sole', 'rubber lug', 'stacked heel', 'microlite'],
      ['width', null, 'standard', 'wide'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.64, 0.33, 0.03],
    cond: 'apparel',
    review: [4.1, 0.9, 220],
    themes: ['sizing', 'comfort', 'break_in', 'leather_quality', 'arch_support', 'durability'],
  },
  womenbags: {
    // Designer bags have a deep authenticated resale and consignment-auction
    // market, so the new share is the smallest in this L1.
    price: [4900, 349900],
    specs: [
      ['material', null, 'Saffiano leather', 'nappa leather', 'suede', 'coated canvas', 'recycled nylon'],
      ['size', 'cm', '18x12x6', '26x18x9', '34x28x12'],
      ['closure', null, 'magnetic snap', 'zip top', 'turnlock', 'drawstring'],
      ['strap', null, 'detachable strap', 'chain strap', 'adjustable strap', 'top handle'],
      ['hardware', null, 'gold-tone', 'silver-tone', 'gunmetal'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.56, 0.36, 0.08],
    cond: 'apparel',
    review: [4.3, 0.8, 190],
    themes: ['leather_quality', 'hardware_quality', 'capacity', 'authenticity', 'colour_accuracy', 'durability'],
  },
  womenaccessories: {
    price: [1900, 79900],
    specs: [
      ['material', null, 'mulberry silk', 'cashmere', 'calfskin', 'acetate', 'brass'],
      ['size', 'cm', '45x45', '70x70', '90x90'],
      ['lens', null, 'polarised', 'UV400', 'gradient tint'],
      ['closure', null, 'pin buckle', 'magnetic', 'snap'],
      ['fit', null, 'One size', 'S/M', 'L/XL'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.68, 0.29, 0.03],
    cond: 'apparel',
    review: [4.2, 0.8, 230],
    themes: ['fabric_quality', 'hardware_quality', 'colour_accuracy', 'sizing', 'durability'],
  },
  womenlingerie: {
    price: [1900, 29900],
    specs: [
      ['size', null, '32B', '34B', '34C', '36C', '36D', 'S', 'M', 'L'],
      ['fabric', null, 'stretch lace', 'silk satin', 'modal', 'bamboo viscose', 'microfibre'],
      ['support', null, 'underwired', 'wire-free', 'light support', 'full support'],
      ['coverage', null, 'full cup', 'balconette', 'plunge', 'bralette'],
      ['set_size', null, 'single', '2-piece set', '3-piece set'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.9, 0.09, 0.01],
    cond: 'nearNew',
    review: [4.1, 0.9, 340],
    themes: ['sizing', 'comfort', 'fabric_quality', 'support', 'durability', 'value'],
  },
  womenactive: {
    price: [2900, 34900],
    specs: [
      ['size', null, 'XS', 'S', 'M', 'L', 'XL'],
      ['fabric', null, 'nylon-elastane', 'recycled polyester', 'brushed jersey', 'seamless knit'],
      ['compression', null, 'light', 'medium', 'high'],
      ['inseam', 'in', '5', '7', '25', '28'],
      ['features', null, 'squat-proof', 'side pockets', 'high waist', 'four-way stretch'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.8, 0.19, 0.01],
    cond: 'apparel',
    review: [4.2, 0.9, 480],
    themes: ['sizing', 'squat_proof', 'comfort', 'stretch_recovery', 'sweat_wicking', 'durability'],
  },
  womenvintage: {
    price: [4900, 249900],
    specs: [
      ['era', null, '1930s', '1950s', '1960s', '1970s', '1980s', '1990s'],
      ['size', null, 'fits XS', 'fits S', 'fits M', 'fits L'],
      ['fabric', null, 'rayon crepe', 'silk', 'wool gabardine', 'cotton lawn'],
      ['flaws', null, 'none noted', 'underarm staining', 'small repair', 'missing button'],
      ['label', null, 'union label', 'designer label', 'handmade', 'unlabelled'],
    ],
    titles: 'lot',
    models: ['{word}', '{N}s {word}', '{A}{N}'],
    mix: [0.05, 0.72, 0.23],
    cond: 'vintage',
    review: [4.2, 1.0, 40],
    themes: ['condition_accuracy', 'sizing', 'authenticity', 'fabric_quality', 'odour', 'value'],
  },
});

// --- Sneakers and streetwear: a secondary market that often exceeds retail.
group('sneakers', {
  runningsneakers: {
    price: [5900, 29900],
    specs: [
      ['size', null, 'US 8', 'US 9', 'US 10', 'US 11', 'US 12'],
      ['drop', 'mm', '0', '4', '8', '10', '12'],
      ['stack_height', 'mm', '28', '34', '40', '46'],
      ['weight', 'g', '190', '230', '270', '310'],
      ['plate', null, 'carbon plate', 'nylon plate', 'no plate'],
      ['cushioning', null, 'firm', 'balanced', 'max cushion'],
    ],
    titles: 'apparel',
    models: ['{word} {N}', '{A}{N}', '{word} {A}{N}'],
    mix: [0.76, 0.22, 0.02],
    cond: 'apparel',
    review: [4.3, 0.8, 330],
    themes: ['sizing', 'cushioning', 'durability', 'breathability', 'arch_support', 'value'],
  },
  basketballsneakers: {
    price: [7900, 49900],
    specs: [
      ['size', null, 'US 8', 'US 9', 'US 10', 'US 11', 'US 12', 'US 13'],
      ['traction', null, 'herringbone', 'radial', 'translucent rubber'],
      ['cushioning', null, 'air unit', 'foam', 'gel', 'pellet foam'],
      ['cut', null, 'high top', 'mid top', 'low top'],
      ['colourway', null, 'team colours', 'OG colourway', 'player exclusive'],
    ],
    titles: 'apparel',
    models: ['{word} {N}', '{A}{N}', '{word} {A}{N}'],
    mix: [0.6, 0.3, 0.1],
    cond: 'apparel',
    review: [4.3, 0.8, 180],
    themes: ['traction', 'cushioning', 'ankle_support', 'sizing', 'durability', 'authenticity'],
  },
  lifestylesneakers: {
    price: [5900, 39900],
    specs: [
      ['size', null, 'US 7', 'US 8', 'US 9', 'US 10', 'US 11', 'US 12'],
      ['upper', null, 'suede', 'canvas', 'full-grain leather', 'knit mesh'],
      ['sole', null, 'vulcanised rubber', 'cupsole', 'gum sole'],
      ['fit', null, 'true to size', 'runs small', 'runs large'],
      ['release', null, 'reissue', 'current line', 'OG release'],
    ],
    titles: 'apparel',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.62, 0.31, 0.07],
    cond: 'apparel',
    review: [4.2, 0.8, 260],
    themes: ['sizing', 'comfort', 'durability', 'colour_accuracy', 'break_in', 'value'],
  },
  streetweartops: {
    price: [3900, 79900],
    specs: [
      ['size', null, 'S', 'M', 'L', 'XL', 'XXL'],
      ['fabric_weight', null, '8 oz', '12 oz', '14 oz', '400 gsm'],
      ['print', null, 'screen print', 'puff print', 'embroidery', 'DTG'],
      ['fit', null, 'boxy', 'oversized', 'regular'],
      ['season', null, 'SS21', 'FW22', 'SS23', 'FW24'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.5, 0.4, 0.1],
    cond: 'apparel',
    review: [4.2, 0.9, 190],
    themes: ['sizing', 'print_quality', 'fabric_quality', 'authenticity', 'shrinkage', 'value'],
  },
  streetwearbottoms: {
    price: [4900, 69900],
    specs: [
      ['size', null, '28', '30', '32', '34', '36'],
      ['fabric', null, 'ripstop nylon', '13oz denim', 'French terry', 'mesh polyester'],
      ['fit', null, 'baggy', 'relaxed', 'straight', 'parachute'],
      ['pockets', null, '6 pockets', 'cargo pockets', 'zip pockets'],
      ['closure', null, 'drawcord', 'button fly', 'zip fly', 'elastic waist'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.55, 0.38, 0.07],
    cond: 'apparel',
    review: [4.2, 0.9, 160],
    themes: ['sizing', 'fabric_quality', 'stitching', 'fit_accuracy', 'durability', 'value'],
  },
  headwear: {
    price: [2900, 24900],
    specs: [
      ['size', null, '7 1/8', '7 1/4', '7 3/8', 'One size', 'S/M', 'L/XL'],
      ['material', null, 'wool blend', 'cotton twill', 'acrylic knit', 'nylon ripstop'],
      ['closure', null, 'fitted', 'snapback', 'strapback', 'buckle'],
      ['brim', null, 'flat brim', 'curved brim', 'no brim'],
      ['crown', null, 'structured', 'unstructured', 'five-panel'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.62, 0.31, 0.07],
    cond: 'apparel',
    review: [4.2, 0.8, 210],
    themes: ['sizing', 'colour_accuracy', 'embroidery_quality', 'shape_retention', 'comfort', 'value'],
  },
  streetwearaccessories: {
    price: [1900, 39900],
    specs: [
      ['material', null, 'Cordura nylon', 'leather', 'ripstop', 'enamel on brass'],
      ['size', 'cm', '8x5', '20x14', '30x22'],
      ['hardware', null, 'YKK zips', 'cast buckle', 'webbing straps'],
      ['pack_size', null, 'single', '2-pack', '3-pack'],
      ['season', null, 'SS22', 'FW23', 'SS24'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.6, 0.32, 0.08],
    cond: 'apparel',
    review: [4.1, 0.9, 140],
    themes: ['authenticity', 'hardware_quality', 'colour_accuracy', 'durability', 'value'],
  },
  sneakercare: {
    price: [900, 9900],
    specs: [
      ['volume', 'ml', '30', '75', '120', '250'],
      ['kit_size', null, '3-piece', '5-piece', '7-piece'],
      ['material', null, 'hog bristle', 'horsehair', 'microfibre', 'cedar'],
      ['use', null, 'suede', 'leather', 'knit', 'all materials'],
      ['finish', null, 'matte', 'satin', 'invisible'],
    ],
    titles: 'consumable',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.94, 0.05, 0.01],
    cond: 'nearNew',
    review: [4.2, 0.8, 290],
    themes: ['effectiveness', 'ease_of_use', 'smell', 'value', 'packaging'],
  },
  collabs: {
    // Collabs sell out at retail in minutes; the market that actually exists is
    // resale and timed auction, so the new share is a rounding error.
    price: [12900, 499900],
    specs: [
      ['release_year', null, '2018', '2020', '2021', '2022', '2023', '2024'],
      ['size', null, 'US 8', 'US 9', 'US 10', 'US 11', 'US 12'],
      ['authentication', null, 'third-party verified', 'receipt included', 'tagged', 'unverified'],
      ['completeness', null, 'OG box and extras', 'OG box', 'replacement box', 'no box'],
      ['edition', null, 'limited run', 'regional exclusive', 'friends and family'],
    ],
    titles: 'lot',
    models: ['{word} {N}', '{A}{N}', '{word} {A}{N}'],
    mix: [0.14, 0.5, 0.36],
    cond: 'collector',
    review: [4.3, 0.9, 60],
    themes: ['authenticity', 'condition_accuracy', 'completeness', 'packaging', 'value', 'sizing'],
  },
  streetweararchive: {
    price: [4900, 299900],
    specs: [
      ['era', null, '1990s', 'Y2K', 'early 2010s'],
      ['size', null, 'S', 'M', 'L', 'XL'],
      ['tag', null, 'single stitch', 'made in USA', 'original brand tag', 'bootleg'],
      ['flaws', null, 'none noted', 'cracked print', 'small holes', 'sun fading'],
      ['rarity', null, 'common', 'uncommon', 'grail'],
    ],
    titles: 'lot',
    models: ['{word}', '{N}s {word}', '{A}{N}'],
    mix: [0.03, 0.68, 0.29],
    cond: 'vintage',
    review: [4.1, 1.0, 35],
    themes: ['authenticity', 'condition_accuracy', 'sizing', 'print_quality', 'odour', 'value'],
  },
});

// --- Watches and jewelry: reference numbers, deep resale, auction at the top end.
group('watches', {
  divewatches: {
    price: [9900, 899900],
    specs: [
      ['case_diameter', 'mm', '38', '40', '41', '42', '44'],
      ['water_resistance', null, '200 m', '300 m', '500 m', '1000 m'],
      ['movement', null, 'automatic', 'hand-wound', 'solar quartz', 'quartz'],
      ['crystal', null, 'sapphire', 'mineral', 'hesalite'],
      ['lug_width', 'mm', '18', '20', '22'],
      ['bezel', null, 'unidirectional ceramic', 'aluminium insert', 'sapphire insert'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{A}{N}-{N}', '{word} {N}', 'Ref. {N}'],
    mix: [0.5, 0.4, 0.1],
    cond: 'gently',
    review: [4.4, 0.7, 130],
    themes: ['build_quality', 'bracelet_quality', 'accuracy', 'lume', 'bezel_action', 'value'],
  },
  dresswatches: {
    price: [9900, 1499900],
    specs: [
      ['case_diameter', 'mm', '34', '36', '38', '40'],
      ['thickness', 'mm', '6', '8', '10', '12'],
      ['movement', null, 'hand-wound', 'automatic', 'micro-rotor', 'quartz'],
      ['dial', null, 'guilloché', 'grand feu enamel', 'sunburst', 'matte'],
      ['case_material', null, 'stainless steel', '18k yellow gold', 'white gold', 'platinum'],
    ],
    titles: 'tech',
    models: ['{A}{N}', 'Ref. {N}', '{word} {N}', '{A}{N}-{N}'],
    mix: [0.48, 0.4, 0.12],
    cond: 'gently',
    review: [4.4, 0.7, 90],
    themes: ['finishing', 'accuracy', 'dial_quality', 'strap_quality', 'thickness', 'value'],
  },
  chronographs: {
    price: [14900, 1299900],
    specs: [
      ['movement', null, 'meca-quartz', 'column wheel automatic', 'cam-lever automatic', 'hand-wound'],
      ['case_diameter', 'mm', '38', '40', '42', '44'],
      ['subdials', null, 'two-register', 'three-register', 'bicompax'],
      ['pushers', null, 'pump pushers', 'rectangular pushers', 'monopusher'],
      ['power_reserve', null, '48 h', '60 h', '72 h'],
    ],
    titles: 'tech',
    models: ['{A}{N}', 'Ref. {N}', '{word} {N}', '{A}{N}{A}'],
    mix: [0.46, 0.4, 0.14],
    cond: 'gently',
    review: [4.4, 0.7, 85],
    themes: ['pusher_feel', 'accuracy', 'finishing', 'legibility', 'bracelet_quality', 'value'],
  },
  toolwatches: {
    price: [7900, 699900],
    specs: [
      ['movement', null, 'automatic GMT', 'solar quartz', 'hand-wound', 'high-accuracy quartz'],
      ['case_diameter', 'mm', '36', '38', '40', '42', '44'],
      ['complication', null, 'GMT', 'day-date', 'world timer', 'alarm'],
      ['lume', null, 'Super-LumiNova BGW9', 'Super-LumiNova C3', 'tritium tubes'],
      ['case_material', null, '316L steel', 'titanium', 'bronze', 'composite resin'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', 'Ref. {N}', '{A}{N}-{N}'],
    mix: [0.55, 0.37, 0.08],
    cond: 'gently',
    review: [4.4, 0.7, 140],
    themes: ['legibility', 'lume', 'accuracy', 'durability', 'strap_quality', 'value'],
  },
  vintagewatches: {
    // Originality is the whole price, and it is argued over publicly — which is
    // exactly the trade that runs through timed auction rather than fixed price.
    price: [19900, 2499900],
    specs: [
      ['era', null, '1940s', '1950s', '1960s', '1970s', '1980s'],
      ['service_history', null, 'recently serviced', 'service papers included', 'unserviced', 'unknown'],
      ['originality', null, 'all original', 'replacement dial', 'relumed', 'service hands'],
      ['case_diameter', 'mm', '33', '34', '36', '38'],
      ['movement', null, 'hand-wound', 'automatic', 'early quartz'],
    ],
    titles: 'lot',
    models: ['Ref. {N}', '{A}{N}', '{word} {N}', '{N}'],
    mix: [0.02, 0.55, 0.43],
    cond: 'vintage',
    review: [4.2, 1.0, 30],
    themes: ['authenticity', 'condition_accuracy', 'service_history', 'dial_quality', 'accuracy', 'value'],
  },
  watchstraps: {
    price: [1900, 39900],
    specs: [
      ['lug_width', 'mm', '18', '19', '20', '21', '22'],
      ['material', null, 'Horween leather', 'FKM rubber', 'nylon NATO', '316L steel', 'alligator'],
      ['length', null, 'short', 'regular', 'long'],
      ['buckle', null, 'pin buckle', 'deployant', 'butterfly clasp'],
      ['thickness', 'mm', '2', '3', '4', '5'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{word}'],
    mix: [0.85, 0.13, 0.02],
    cond: 'gently',
    review: [4.3, 0.8, 260],
    themes: ['fit_accuracy', 'leather_quality', 'hardware_quality', 'comfort', 'durability', 'value'],
  },
  rings: {
    price: [4900, 499900],
    specs: [
      ['metal', null, 'sterling silver', '14k gold', '18k gold', 'platinum', 'titanium'],
      ['ring_size', null, 'US 5', 'US 6', 'US 7', 'US 9', 'US 11'],
      ['stone', null, 'diamond', 'sapphire', 'emerald', 'moissanite', 'no stone'],
      ['carat', null, '0.25 ct', '0.5 ct', '1.0 ct', '1.5 ct'],
      ['band_width', 'mm', '2', '3', '4', '6', '8'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.66, 0.26, 0.08],
    cond: 'gently',
    review: [4.4, 0.7, 150],
    themes: ['finishing', 'metal_quality', 'sizing', 'stone_quality', 'durability', 'packaging'],
  },
  necklaces: {
    price: [3900, 399900],
    specs: [
      ['metal', null, 'sterling silver', '14k gold', '18k gold', 'gold vermeil', 'platinum'],
      ['length', 'cm', '40', '45', '50', '60', '70'],
      ['chain_style', null, 'cable', 'curb', 'box', 'rope', 'Cuban'],
      ['clasp', null, 'lobster', 'spring ring', 'toggle', 'magnetic'],
      ['stone', null, 'freshwater pearl', 'diamond', 'turquoise', 'no stone'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.68, 0.25, 0.07],
    cond: 'gently',
    review: [4.3, 0.8, 180],
    themes: ['finishing', 'metal_quality', 'clasp_quality', 'tarnishing', 'packaging', 'value'],
  },
  earrings: {
    price: [2900, 299900],
    specs: [
      ['metal', null, 'sterling silver', '14k gold', '18k gold', 'gold vermeil', 'surgical steel'],
      ['back', null, 'butterfly back', 'screw back', 'lever back', 'hoop clasp'],
      ['diameter', 'mm', '8', '12', '20', '30', '50'],
      ['stone', null, 'diamond', 'cubic zirconia', 'pearl', 'enamel'],
      ['weight', 'g', '1', '2', '4', '8'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.72, 0.22, 0.06],
    cond: 'gently',
    review: [4.3, 0.8, 200],
    themes: ['comfort', 'metal_quality', 'finishing', 'clasp_quality', 'tarnishing', 'value'],
  },
  finejewelry: {
    // Estate and signed pieces are consigned rather than listed: the auction
    // share is the highest of any L2 outside art.
    price: [29900, 4999900],
    specs: [
      ['metal', null, '18k yellow gold', 'platinum', 'white gold', 'rose gold'],
      ['carat', null, '0.5 ct', '1.0 ct', '2.0 ct', '3.5 ct'],
      ['certification', null, 'GIA certified', 'IGI certified', 'appraisal included', 'uncertified'],
      ['stone', null, 'diamond', 'Burmese ruby', 'Ceylon sapphire', 'Colombian emerald'],
      ['period', null, 'Victorian', 'Art Deco', 'Retro', 'contemporary'],
    ],
    titles: 'lot',
    models: ['{word}', '{A}{N}', '{word} {N}'],
    mix: [0.3, 0.28, 0.42],
    cond: 'collector',
    review: [4.4, 0.8, 45],
    themes: ['authenticity', 'stone_quality', 'certification', 'finishing', 'condition_accuracy', 'packaging'],
  },
});

// --- Beauty and grooming: hygiene goods, so effectively no resale except scent.
group('beauty', {
  skincare: {
    price: [900, 24900],
    specs: [
      ['volume', 'ml', '15', '30', '50', '100'],
      ['active', null, 'niacinamide 10%', 'L-ascorbic acid 15%', 'retinal 0.1%', 'azelaic acid 10%', 'salicylic acid 2%'],
      ['skin_type', null, 'oily', 'dry', 'combination', 'sensitive'],
      ['spf', null, 'SPF 30', 'SPF 50', 'SPF 50+', 'no SPF'],
      ['texture', null, 'gel', 'lotion', 'cream', 'essence'],
    ],
    titles: 'consumable',
    models: ['{A}{N}', '{word}', '{word} {N}'],
    mix: [0.96, 0.04, 0.0],
    cond: 'nearNew',
    review: [4.2, 0.9, 880],
    themes: ['effectiveness', 'texture', 'irritation', 'scent', 'absorption', 'value'],
  },
  makeup: {
    price: [900, 14900],
    specs: [
      ['shade', null, 'Fair 01', 'Light 10', 'Medium 25', 'Tan 40', 'Deep 60'],
      ['finish', null, 'matte', 'satin', 'dewy', 'radiant'],
      ['coverage', null, 'sheer', 'medium', 'full', 'buildable'],
      ['volume', 'ml', '5', '8', '12', '30'],
      ['formula', null, 'oil-free', 'vegan', 'fragrance-free', 'long-wear'],
    ],
    titles: 'consumable',
    models: ['{A}{N}', '{word}', '{word} {N}'],
    mix: [0.96, 0.04, 0.0],
    cond: 'nearNew',
    review: [4.1, 1.0, 1200],
    themes: ['shade_range', 'wear_time', 'coverage', 'texture', 'packaging', 'value'],
  },
  haircare: {
    price: [900, 12900],
    specs: [
      ['volume', 'ml', '100', '250', '500', '1000'],
      ['hair_type', null, 'fine', 'thick', 'curly', 'colour-treated', 'coily'],
      ['concern', null, 'frizz', 'volume', 'scalp health', 'damage repair'],
      ['formula', null, 'sulphate-free', 'silicone-free', 'contains sulphates'],
      ['scent', null, 'unscented', 'citrus', 'vanilla', 'herbal'],
    ],
    titles: 'consumable',
    models: ['{A}{N}', '{word}', '{word} {N}'],
    mix: [0.97, 0.03, 0.0],
    cond: 'nearNew',
    review: [4.1, 1.0, 940],
    themes: ['effectiveness', 'scent', 'residue', 'value', 'packaging'],
  },
  hairtools: {
    price: [1900, 44900],
    specs: [
      ['power', 'W', '1200', '1600', '1875', '2200'],
      ['heat_settings', null, '3 settings', '5 settings', 'variable to 230 C'],
      ['plate_material', null, 'ceramic', 'tourmaline', 'titanium', 'ceramic-coated'],
      ['plate_width', 'mm', '19', '25', '32', '38'],
      ['motor', null, 'AC motor', 'DC motor', 'brushless'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{A}{N}-{N}'],
    mix: [0.9, 0.09, 0.01],
    cond: 'electronics',
    review: [4.1, 0.9, 520],
    themes: ['heat_up_time', 'noise', 'build_quality', 'hair_damage', 'ease_of_use', 'durability'],
  },
  shaving: {
    price: [1200, 29900],
    specs: [
      ['handle_material', null, 'chrome-plated brass', 'stainless steel', 'resin', 'olive wood'],
      ['aggression', null, 'mild', 'medium', 'aggressive', 'adjustable'],
      ['blade_type', null, 'DE blade', 'single edge', 'cartridge', 'straight'],
      ['knot_size', 'mm', '22', '24', '26', '28'],
      ['bristle', null, 'boar', 'badger', 'synthetic'],
    ],
    titles: 'homegoods',
    models: ['{A}{N}', '{word} {N}', '{word}'],
    mix: [0.88, 0.1, 0.02],
    cond: 'gently',
    review: [4.4, 0.7, 310],
    themes: ['closeness', 'irritation', 'build_quality', 'lather_quality', 'ergonomics', 'value'],
  },
  fragrance: {
    // Splits, decants and hunts for pre-reformulation batches make this the one
    // beauty L2 with a real secondary market.
    price: [1900, 49900],
    specs: [
      ['concentration', null, 'eau de toilette', 'eau de parfum', 'extrait de parfum', 'cologne'],
      ['volume', 'ml', '10', '30', '50', '100'],
      ['family', null, 'woody', 'floral', 'chypre', 'oriental', 'aromatic fougère'],
      ['longevity', null, '3-4 h', '5-6 h', '8+ h'],
      ['batch', null, 'current batch', 'pre-reformulation', 'vintage batch'],
    ],
    titles: 'consumable',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.72, 0.25, 0.03],
    cond: 'nearNew',
    review: [4.3, 0.9, 410],
    themes: ['scent', 'longevity', 'sillage', 'authenticity', 'packaging', 'value'],
  },
  nails: {
    price: [600, 9900],
    specs: [
      ['volume', 'ml', '8', '10', '15'],
      ['finish', null, 'creme', 'shimmer', 'jelly', 'holographic'],
      ['formula', null, '5-free', '10-free', 'gel', 'breathable'],
      ['cure_time', null, '30 s', '60 s', '120 s', 'air dry'],
      ['power', 'W', '24', '36', '48'],
    ],
    titles: 'consumable',
    models: ['{A}{N}', '{word}', '{word} {N}'],
    mix: [0.97, 0.03, 0.0],
    cond: 'nearNew',
    review: [4.0, 1.0, 620],
    themes: ['wear_time', 'application', 'colour_accuracy', 'smell', 'value'],
  },
  bathbody: {
    price: [700, 12900],
    specs: [
      ['volume', 'ml', '100', '250', '500', '750'],
      ['scent', null, 'unscented', 'cedar', 'neroli', 'sandalwood', 'citrus'],
      ['skin_type', null, 'dry', 'sensitive', 'normal', 'eczema-prone'],
      ['format', null, 'bar', 'liquid', 'cream', 'oil'],
      ['ingredients', null, 'shea butter', 'colloidal oatmeal', 'glycerin', 'squalane'],
    ],
    titles: 'consumable',
    models: ['{word}', '{A}{N}', '{word} {N}'],
    mix: [0.97, 0.03, 0.0],
    cond: 'nearNew',
    review: [4.2, 0.9, 710],
    themes: ['scent', 'moisturising', 'irritation', 'value', 'packaging'],
  },
  grooming: {
    price: [900, 19900],
    specs: [
      ['volume', 'ml', '30', '50', '100', '150'],
      ['hold', null, 'light hold', 'medium hold', 'strong hold'],
      ['finish', null, 'matte', 'natural', 'high shine'],
      ['base', null, 'water-based', 'oil-based', 'clay', 'wax'],
      ['beard_length', null, 'stubble', 'short', 'medium', 'full'],
    ],
    titles: 'consumable',
    models: ['{word}', '{A}{N}', '{word} {N}'],
    mix: [0.93, 0.06, 0.01],
    cond: 'nearNew',
    review: [4.2, 0.9, 480],
    themes: ['hold', 'scent', 'residue', 'ease_of_use', 'value'],
  },
  beautytools: {
    price: [900, 39900],
    specs: [
      ['material', null, 'synthetic taklon', 'goat hair', 'stainless steel', 'nephrite jade', 'silicone'],
      ['set_size', null, '5-piece', '8-piece', '12-piece'],
      ['power', 'W', '3', '8', '15'],
      ['wavelength', null, '415 nm blue', '630 nm red', '830 nm near-infrared'],
      ['handle', null, 'wooden handle', 'aluminium ferrule', 'ergonomic grip'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{word}'],
    mix: [0.94, 0.05, 0.01],
    cond: 'nearNew',
    review: [4.1, 0.9, 390],
    themes: ['build_quality', 'effectiveness', 'ease_of_use', 'shedding', 'cleaning', 'value'],
  },
});

// --- Fitness and outdoors: gear bought once, used hard, resold when outgrown.
group('fitness', {
  strength: {
    price: [2900, 299900],
    specs: [
      ['weight_range', null, '5-52.5 lb', '4-32 kg', '10-90 lb', 'fixed'],
      ['material', null, 'cast iron', 'urethane-coated', 'powder-coated steel', 'rubber-coated'],
      ['knurling', null, 'passive', 'aggressive', 'dual knurl'],
      ['capacity', null, '500 lb', '700 lb', '1000 lb'],
      ['bar_diameter', 'mm', '25', '28', '29', '32'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{A}{N}-{N}'],
    mix: [0.7, 0.28, 0.02],
    cond: 'hardUse',
    review: [4.4, 0.7, 290],
    themes: ['build_quality', 'knurling', 'durability', 'adjustment_mechanism', 'noise', 'value'],
  },
  cardio: {
    price: [14900, 449900],
    specs: [
      ['resistance', null, 'magnetic', 'air', 'water', 'friction'],
      ['max_user_weight', null, '120 kg', '150 kg', '180 kg'],
      ['incline', null, '0-12%', '0-15%', '-3 to 15%'],
      ['power', 'W', '1500', '2200', '3000'],
      ['footprint', 'cm', '140x70', '180x85', '210x90'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{A}{N}-{N}'],
    mix: [0.68, 0.3, 0.02],
    cond: 'hardUse',
    review: [4.1, 1.0, 220],
    themes: ['noise', 'stability', 'build_quality', 'assembly', 'app_experience', 'delivery'],
  },
  yoga: {
    price: [1200, 79900],
    specs: [
      ['thickness', 'mm', '3', '4', '5', '6', '8'],
      ['material', null, 'natural rubber', 'TPE', 'cork', 'PU leather', 'EVA foam'],
      ['size', 'cm', '61x173', '66x180', '68x185'],
      ['density', null, 'firm', 'medium', 'soft'],
      ['amplitude', 'mm', '8', '12', '16'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.84, 0.15, 0.01],
    cond: 'gently',
    review: [4.3, 0.8, 430],
    themes: ['grip', 'cushioning', 'odour', 'durability', 'portability', 'value'],
  },
  running: {
    price: [1900, 69900],
    specs: [
      ['capacity', 'L', '1', '2', '5', '12', '20'],
      ['fit', null, 'XS/S', 'M/L', 'unisex'],
      ['battery_life', null, '12 h GPS', '20 h GPS', '40 h GPS'],
      ['features', null, 'reflective trim', 'bottle pockets', 'emergency whistle', 'multiband GPS'],
      ['weight', 'g', '90', '150', '240', '320'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.84, 0.15, 0.01],
    cond: 'apparel',
    review: [4.3, 0.8, 250],
    themes: ['fit_accuracy', 'bounce', 'capacity', 'breathability', 'durability', 'value'],
  },
  camping: {
    price: [2900, 129900],
    specs: [
      ['capacity', null, '1-person', '2-person', '4-person', '6-person'],
      ['weight', 'g', '900', '1400', '2400', '3800'],
      ['temperature_rating', null, '-7 C', '0 C', '5 C', '10 C'],
      ['material', null, '20D ripstop nylon', '70D polyester', 'Dyneema composite', 'cotton canvas'],
      ['packed_size', 'cm', '15x40', '20x50', '25x60'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.78, 0.2, 0.02],
    cond: 'hardUse',
    review: [4.3, 0.8, 270],
    themes: ['weather_resistance', 'weight', 'packability', 'setup_ease', 'durability', 'warmth'],
  },
  hiking: {
    price: [3900, 89900],
    specs: [
      ['size', null, 'UK 7', 'UK 9', 'US 10', 'EU 42', 'EU 44'],
      ['waterproofing', null, 'Gore-Tex', 'eVent', 'DWR only', 'non-waterproof'],
      ['capacity', 'L', '18', '25', '35', '45'],
      ['weight', 'g', '380', '620', '900', '1400'],
      ['sole', null, 'Vibram Megagrip', 'Contagrip', 'in-house rubber'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.8, 0.19, 0.01],
    cond: 'hardUse',
    review: [4.3, 0.8, 310],
    themes: ['sizing', 'break_in', 'weather_resistance', 'traction', 'comfort', 'durability'],
  },
  climbing: {
    price: [1900, 89900],
    specs: [
      ['size', null, 'EU 38', 'EU 40', 'EU 42', 'EU 44'],
      ['last', null, 'neutral', 'moderate downturn', 'aggressive downturn'],
      ['rope_diameter', 'mm', '8.5', '9.2', '9.8', '10.2'],
      ['length', null, '60 m', '70 m', '80 m'],
      ['closure', null, 'velcro', 'lace-up', 'slipper'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.82, 0.17, 0.01],
    cond: 'hardUse',
    review: [4.4, 0.7, 190],
    themes: ['sizing', 'edging', 'durability', 'comfort', 'break_in', 'value'],
  },
  watersports: {
    price: [2900, 249900],
    specs: [
      ['thickness', 'mm', '2', '3', '4', '5'],
      ['length', 'cm', '244', '275', '320', '366'],
      ['volume', 'L', '90', '120', '240', '320'],
      ['material', null, 'limestone neoprene', 'PVC drop-stitch', 'thermoformed polymer', 'epoxy'],
      ['seams', null, 'glued and blind-stitched', 'flatlock', 'taped'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.74, 0.24, 0.02],
    cond: 'hardUse',
    review: [4.2, 0.9, 170],
    themes: ['warmth', 'fit_accuracy', 'durability', 'stability', 'packability', 'value'],
  },
  wintersports: {
    price: [4900, 179900],
    specs: [
      ['length', 'cm', '155', '165', '172', '180'],
      ['flex', null, 'soft', 'medium', 'stiff', 'race'],
      ['waist_width', 'mm', '78', '88', '96', '104'],
      ['binding', null, 'strap-in', 'rear-entry', 'alpine touring', 'hybrid'],
      ['lens', null, 'low light', 'all-conditions', 'bright sun', 'photochromic'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.62, 0.35, 0.03],
    cond: 'hardUse',
    review: [4.2, 0.9, 150],
    themes: ['flex', 'edge_hold', 'sizing', 'durability', 'comfort', 'value'],
  },
  cycling: {
    price: [4900, 899900],
    specs: [
      ['frame_material', null, '6061 aluminium', 'carbon fibre', 'chromoly steel', 'titanium'],
      ['frame_size', null, '49 cm', '52 cm', '54 cm', '56 cm', '58 cm'],
      ['groupset', null, '105', 'Rival AXS', 'GRX', 'Deore XT', 'Apex'],
      ['wheel_size', null, '700c', '650b', '29 in', '27.5 in'],
      ['weight', 'g', '7800', '9200', '11500', '14000'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{A}{N}-{N}'],
    mix: [0.6, 0.36, 0.04],
    cond: 'mechanical',
    review: [4.3, 0.8, 180],
    themes: ['build_quality', 'component_quality', 'sizing', 'ride_comfort', 'assembly', 'value'],
  },
});

// --- Sports gear: consumables and kit, bought new, retired hard.
group('sports', {
  basketballgear: {
    price: [1900, 129900],
    specs: [
      ['ball_size', null, 'size 5', 'size 6', 'size 7'],
      ['material', null, 'composite leather', 'full-grain leather', 'rubber'],
      ['backboard', null, '44 in acrylic', '54 in polycarbonate', '60 in tempered glass'],
      ['adjustment', null, '7.5-10 ft', '8-10 ft', 'fixed height'],
      ['use', null, 'indoor', 'outdoor', 'indoor/outdoor'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.85, 0.14, 0.01],
    cond: 'hardUse',
    review: [4.2, 0.9, 220],
    themes: ['grip', 'durability', 'assembly', 'build_quality', 'value'],
  },
  soccer: {
    price: [1900, 39900],
    specs: [
      ['ball_size', null, 'size 3', 'size 4', 'size 5'],
      ['certification', null, 'FIFA Quality Pro', 'FIFA Basic', 'IMS approved'],
      ['stud_type', null, 'firm ground', 'soft ground', 'artificial grass', 'indoor'],
      ['upper', null, 'kangaroo leather', 'synthetic', 'knit'],
      ['size', null, 'UK 7', 'UK 8', 'US 9', 'EU 42'],
    ],
    titles: 'apparel',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.86, 0.13, 0.01],
    cond: 'hardUse',
    review: [4.2, 0.9, 240],
    themes: ['sizing', 'traction', 'touch', 'durability', 'comfort', 'value'],
  },
  racquet: {
    price: [1900, 89900],
    specs: [
      ['head_size', null, '95 sq in', '98 sq in', '100 sq in', '104 sq in'],
      ['weight', 'g', '270', '300', '315', '330'],
      ['balance', null, 'head light', 'even balance', 'head heavy'],
      ['string_pattern', null, '16x19', '18x20', '16x20'],
      ['grip_size', null, 'G1', 'G2', 'G3', 'G4'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{A}{N}-{N}'],
    mix: [0.8, 0.19, 0.01],
    cond: 'hardUse',
    review: [4.3, 0.8, 190],
    themes: ['balance', 'power', 'control', 'comfort', 'grip', 'value'],
  },
  golf: {
    price: [2900, 249900],
    specs: [
      ['loft', null, '9 degrees', '10.5 degrees', '12 degrees'],
      ['shaft', null, 'regular flex graphite', 'stiff graphite', 'extra stiff', 'steel'],
      ['set_makeup', null, '4-PW', '5-PW', '6-PW plus AW'],
      ['head_material', null, 'titanium', 'forged carbon steel', 'cast stainless'],
      ['hand', null, 'right hand', 'left hand'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{A}{N}-{N}'],
    mix: [0.62, 0.34, 0.04],
    cond: 'mechanical',
    review: [4.2, 0.9, 200],
    themes: ['forgiveness', 'distance', 'feel', 'build_quality', 'sizing', 'value'],
  },
  baseball: {
    price: [1900, 59900],
    specs: [
      ['size', 'in', '11', '11.5', '11.75', '12.5'],
      ['material', null, 'full-grain steerhide', 'kip leather', 'synthetic'],
      ['position', null, 'infield', 'outfield', 'catcher', 'pitcher'],
      ['bat_drop', null, '-3', '-5', '-8', '-10'],
      ['certification', null, 'BBCOR', 'USSSA', 'USA Baseball'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.78, 0.2, 0.02],
    cond: 'hardUse',
    review: [4.3, 0.8, 170],
    themes: ['break_in', 'leather_quality', 'durability', 'sizing', 'pocket_shape', 'value'],
  },
  combat: {
    price: [1900, 89900],
    specs: [
      ['weight', null, '8 oz', '10 oz', '12 oz', '16 oz'],
      ['material', null, 'full-grain leather', 'synthetic leather', 'vinyl'],
      ['padding', null, 'layered foam', 'gel', 'horsehair'],
      ['closure', null, 'velcro', 'lace-up', 'hybrid'],
      ['filling', null, 'unfilled', 'sand-filled', 'water-filled'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.85, 0.14, 0.01],
    cond: 'hardUse',
    review: [4.3, 0.8, 210],
    themes: ['padding', 'wrist_support', 'durability', 'smell', 'sizing', 'value'],
  },
  skate: {
    price: [1900, 39900],
    specs: [
      ['deck_width', 'in', '7.75', '8', '8.25', '8.5'],
      ['construction', null, '7-ply maple', '8-ply maple', 'carbon-reinforced'],
      ['durometer', null, '78A', '87A', '99A', '101A'],
      ['bearing_rating', null, 'ABEC 5', 'ABEC 7', 'ABEC 9'],
      ['truck_height', null, 'low', 'mid', 'high'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.86, 0.13, 0.01],
    cond: 'hardUse',
    review: [4.3, 0.8, 230],
    themes: ['pop', 'durability', 'grip', 'build_quality', 'value'],
  },
  tablesports: {
    price: [2900, 349900],
    specs: [
      ['size', null, '7 ft', '8 ft', '9 ft'],
      ['surface', null, '16 mm MDF', '19 mm MDF', '25 mm slate', 'sisal'],
      ['folding', null, 'foldable', 'fixed', 'roll-away'],
      ['blade', null, '5-ply wood', '7-ply wood', 'carbon inlay'],
      ['rubber', null, 'pips-in', 'pips-out', 'anti-spin'],
    ],
    titles: 'homegoods',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.84, 0.14, 0.02],
    cond: 'hardUse',
    review: [4.1, 0.9, 150],
    themes: ['build_quality', 'assembly', 'playing_surface', 'stability', 'value'],
  },
  fishing: {
    price: [1900, 129900],
    specs: [
      ['length', null, '6 ft', '7 ft', '8 ft', '9 ft'],
      ['power', null, 'ultralight', 'light', 'medium', 'medium-heavy', 'heavy'],
      ['action', null, 'fast', 'moderate-fast', 'slow'],
      ['gear_ratio', null, '5.2:1', '6.4:1', '7.1:1'],
      ['line_rating', null, '4-8 lb', '8-17 lb', '15-30 lb'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{A}{N}-{N}'],
    mix: [0.8, 0.18, 0.02],
    cond: 'hardUse',
    review: [4.3, 0.8, 180],
    themes: ['sensitivity', 'build_quality', 'drag_smoothness', 'durability', 'ergonomics', 'value'],
  },
  fanwear: {
    // Match-worn and long-out-of-print season kits are consigned to auction,
    // which is why this is the one sports L2 with a real auction share.
    price: [1900, 49900],
    specs: [
      ['size', null, 'S', 'M', 'L', 'XL', 'XXL'],
      ['season', null, '1998/99', '2006/07', '2014/15', '2023/24'],
      ['authenticity', null, 'official licensed', 'player issue', 'replica', 'unlicensed'],
      ['badging', null, 'heat-pressed', 'embroidered', 'stitched twill'],
      ['fit', null, 'authentic fit', 'replica fit', 'retro fit'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.58, 0.3, 0.12],
    cond: 'apparel',
    review: [4.2, 0.9, 130],
    themes: ['authenticity', 'sizing', 'print_quality', 'fabric_quality', 'colour_accuracy', 'value'],
  },
});

// --- Music and audio: long-lived gear with an unusually liquid used market.
group('audio', {
  headphones: {
    price: [4900, 399900],
    specs: [
      ['driver_size', 'mm', '40', '45', '50', '53'],
      ['impedance', null, '32 ohm', '150 ohm', '250 ohm', '300 ohm'],
      ['design', null, 'open-back', 'closed-back', 'semi-open'],
      ['connection', null, 'wired 3.5mm', 'XLR balanced', 'bluetooth', 'USB-C'],
      ['frequency_response', 'Hz', '20-20000', '5-40000', '10-50000'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{A}{N}-{N}', '{word} {N}', '{A}{N}{A}'],
    mix: [0.66, 0.31, 0.03],
    cond: 'electronics',
    review: [4.4, 0.7, 280],
    themes: ['sound_signature', 'comfort', 'build_quality', 'soundstage', 'isolation', 'value'],
  },
  earbuds: {
    price: [1900, 149900],
    specs: [
      ['driver', null, 'single dynamic', 'dual balanced armature', 'planar magnetic', 'hybrid 1DD+2BA'],
      ['impedance', null, '16 ohm', '32 ohm', '64 ohm'],
      ['anc', null, 'hybrid ANC', 'feedforward ANC', 'no ANC'],
      ['battery_life', null, '6 h', '8 h', '10 h', '12 h'],
      ['cable', null, '2-pin detachable', 'MMCX', 'fixed cable'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{A}{N}{A}'],
    mix: [0.74, 0.24, 0.02],
    cond: 'electronics',
    review: [4.2, 0.9, 420],
    themes: ['sound_signature', 'fit_accuracy', 'isolation', 'battery_life', 'build_quality', 'value'],
  },
  speakers: {
    price: [7900, 599900],
    specs: [
      ['driver_size', 'in', '4', '5.25', '6.5', '8'],
      ['power', 'W', '30', '60', '100', '150', '250'],
      ['impedance', null, '4 ohm', '6 ohm', '8 ohm'],
      ['enclosure', null, 'sealed', 'ported', 'transmission line'],
      ['connectivity', null, 'binding posts', 'XLR', 'Wi-Fi streaming', 'bluetooth'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{A}{N}-{N}', '{word} {N}'],
    mix: [0.62, 0.34, 0.04],
    cond: 'electronics',
    review: [4.4, 0.7, 190],
    themes: ['sound_signature', 'bass_response', 'build_quality', 'imaging', 'connectivity', 'value'],
  },
  ampsdacs: {
    price: [9900, 499900],
    specs: [
      ['output_power', 'W', '1', '2', '5', '50', '100'],
      ['dac_chip', null, 'ES9038Pro', 'AK4499', 'CS43198', 'R-2R ladder'],
      ['inputs', null, 'USB', 'optical', 'coaxial', 'XLR', 'RCA'],
      ['gain', null, 'low gain', 'high gain', '3-stage gain'],
      ['tubes', null, '12AU7', 'EL84', '6SN7', 'solid state'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{A}{N}-{N}'],
    mix: [0.6, 0.36, 0.04],
    cond: 'electronics',
    review: [4.4, 0.7, 140],
    themes: ['sound_signature', 'noise_floor', 'build_quality', 'connectivity', 'heat', 'value'],
  },
  turntables: {
    // The L2 carries LP records alongside the hardware, and records are an
    // almost entirely used-goods trade — hence the inverted new/used split.
    price: [1500, 399900],
    specs: [
      ['speed', null, '33 1/3', '45', '78'],
      ['drive', null, 'belt drive', 'direct drive', 'idler drive'],
      ['cartridge', null, 'moving magnet', 'moving coil', 'ceramic'],
      ['tracking_force', null, '1.5 g', '1.8 g', '2.0 g', '2.5 g'],
      ['pressing', null, 'original pressing', 'reissue', '180 g', 'coloured vinyl'],
    ],
    titles: 'lot',
    models: ['{A}{N}', '{word} {N}', 'Mk{N}'],
    mix: [0.34, 0.56, 0.1],
    cond: 'media',
    review: [4.3, 0.8, 120],
    themes: ['sound_signature', 'build_quality', 'condition_accuracy', 'setup_ease', 'packaging', 'value'],
  },
  guitars: {
    price: [9900, 599900],
    specs: [
      ['body_wood', null, 'alder', 'ash', 'mahogany', 'basswood', 'Sitka spruce'],
      ['pickups', null, 'single coil', 'humbucker', 'P90', 'piezo'],
      ['scale_length', 'in', '24.75', '25.5', '34'],
      ['frets', null, '21 frets', '22 frets', '24 frets'],
      ['finish', null, 'nitrocellulose', 'polyurethane', 'satin', 'relic'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{A}{N}-{N}'],
    mix: [0.5, 0.44, 0.06],
    cond: 'instrument',
    review: [4.4, 0.7, 160],
    themes: ['playability', 'tone', 'fit_and_finish', 'setup_quality', 'hardware_quality', 'value'],
  },
  synths: {
    price: [9900, 499900],
    specs: [
      ['voices', null, 'monophonic', '4-voice', '8-voice', '16-voice'],
      ['keys', null, '25 keys', '37 keys', '49 keys', '61 keys', '88 keys'],
      ['synthesis', null, 'analogue subtractive', 'FM', 'wavetable', 'sample-based'],
      ['connectivity', null, 'MIDI DIN', 'USB-C', 'CV/gate', 'DIN sync'],
      ['action', null, 'weighted hammer', 'semi-weighted', 'synth action'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', 'Mk{N}'],
    mix: [0.56, 0.4, 0.04],
    cond: 'instrument',
    review: [4.4, 0.7, 130],
    themes: ['sound_signature', 'build_quality', 'key_action', 'workflow', 'connectivity', 'value'],
  },
  drums: {
    price: [4900, 399900],
    specs: [
      ['shell_material', null, 'maple', 'birch', 'mahogany', 'acrylic'],
      ['sizes', null, '20/12/14', '22/12/16', '24/13/16'],
      ['cymbal_size', 'in', '14', '16', '18', '20', '22'],
      ['alloy', null, 'B20 bronze', 'B8 bronze', 'brass'],
      ['pads', null, 'mesh heads', 'rubber pads', 'silicone pads'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', 'Mk{N}'],
    mix: [0.55, 0.41, 0.04],
    cond: 'instrument',
    review: [4.3, 0.8, 120],
    themes: ['tone', 'build_quality', 'hardware_quality', 'noise', 'assembly', 'value'],
  },
  studio: {
    price: [2900, 249900],
    specs: [
      ['io', null, '2-in/2-out', '4-in/4-out', '8-in/8-out', '18-in/20-out'],
      ['sample_rate', 'Hz', '44100', '96000', '192000'],
      ['polar_pattern', null, 'cardioid', 'omnidirectional', 'figure-8', 'multi-pattern'],
      ['connection', null, 'USB-C', 'Thunderbolt', 'XLR', 'AES/EBU'],
      ['absorption', null, 'NRC 0.6', 'NRC 0.9', 'NRC 1.0'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{A}{N}-{N}'],
    mix: [0.72, 0.26, 0.02],
    cond: 'electronics',
    review: [4.4, 0.7, 210],
    themes: ['noise_floor', 'build_quality', 'latency', 'ease_of_use', 'sound_signature', 'value'],
  },
  djgear: {
    price: [9900, 449900],
    specs: [
      ['channels', null, '2-channel', '4-channel', '6-channel'],
      ['jog_wheel', null, 'capacitive touch', 'motorised', 'static'],
      ['screen', null, 'no screen', '7 in colour', '9 in touchscreen'],
      ['software', null, 'Serato', 'rekordbox', 'Traktor', 'standalone'],
      ['outputs', null, 'RCA', 'XLR out', 'booth out', 'USB'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{A}{N}-{N}', '{word} {N}'],
    mix: [0.62, 0.35, 0.03],
    cond: 'electronics',
    review: [4.3, 0.8, 140],
    themes: ['build_quality', 'jog_feel', 'software', 'connectivity', 'durability', 'value'],
  },
});

// --- Gaming: half live retail, half a grading-and-auction collector economy.
group('gaming', {
  consoles: {
    price: [4900, 79900],
    specs: [
      ['storage', null, '64GB eMMC', '512GB SSD', '1TB SSD', '2TB SSD'],
      ['generation', null, 'current gen', 'last gen', 'retro', 'mini'],
      ['region', null, 'NTSC-U', 'PAL', 'NTSC-J'],
      ['bundle', null, 'console only', 'game bundle', 'two controllers'],
      ['output', null, 'HDMI 2.1', 'HDMI 1.4', 'composite', 'RF'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{A}{N} Slim'],
    mix: [0.5, 0.42, 0.08],
    cond: 'electronics',
    review: [4.3, 0.8, 260],
    themes: ['build_quality', 'noise', 'condition_accuracy', 'completeness', 'performance', 'value'],
  },
  games: {
    // Sealed and graded copies clear at auction; loose discs do not. The mix is
    // the blend of those two very different trades.
    price: [900, 149900],
    specs: [
      ['platform', null, 'PS5', 'Switch', 'Xbox Series X', 'PS2', 'SNES'],
      ['region', null, 'NTSC-U', 'PAL', 'NTSC-J'],
      ['completeness', null, 'complete in box', 'disc only', 'cartridge only', 'factory sealed'],
      ['grade', null, 'ungraded', 'WATA 8.0', 'VGA 85', 'CGC 9.4'],
      ['edition', null, 'standard', 'deluxe', 'collector edition', 'steelbook'],
    ],
    titles: 'lot',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.4, 0.38, 0.22],
    cond: 'collector',
    review: [4.2, 0.9, 150],
    themes: ['completeness', 'condition_accuracy', 'authenticity', 'packaging', 'region_compatibility', 'value'],
  },
  controllers: {
    price: [1900, 69900],
    specs: [
      ['connection', null, 'wired USB-C', 'bluetooth', '2.4ghz dongle'],
      ['sticks', null, 'hall effect', 'potentiometer', 'TMR'],
      ['back_buttons', null, 'none', '2 paddles', '4 paddles'],
      ['compatibility', null, 'PC', 'PlayStation', 'Xbox', 'Switch', 'multi-platform'],
      ['weight', 'g', '210', '250', '290', '1100'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{A}{N} Pro'],
    mix: [0.72, 0.26, 0.02],
    cond: 'electronics',
    review: [4.2, 0.9, 290],
    themes: ['build_quality', 'stick_drift', 'button_feel', 'comfort', 'software', 'value'],
  },
  pcgaming: {
    price: [1900, 99900],
    specs: [
      ['sensor', null, '26K DPI optical', '30K DPI optical', '8K polling'],
      ['weight', 'g', '49', '58', '68', '85'],
      ['switch_type', null, 'optical', 'mechanical', 'membrane'],
      ['connection', null, 'wired', '2.4ghz', 'bluetooth', 'tri-mode'],
      ['surface', null, 'cloth', 'hybrid', 'glass', 'hard polymer'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{A}{N}-{N}'],
    mix: [0.78, 0.2, 0.02],
    cond: 'electronics',
    review: [4.3, 0.8, 340],
    themes: ['build_quality', 'sensor_accuracy', 'comfort', 'software', 'durability', 'value'],
  },
  vr: {
    price: [2900, 149900],
    specs: [
      ['resolution', null, '1832x1920 per eye', '2064x2208 per eye', '2880x2880 per eye'],
      ['refresh_rate', 'Hz', '72', '90', '120'],
      ['tracking', null, 'inside-out', 'base station', 'hybrid'],
      ['field_of_view', null, '96 degrees', '110 degrees', '130 degrees'],
      ['weight', 'g', '420', '515', '620', '720'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{A}{N} Pro'],
    mix: [0.68, 0.3, 0.02],
    cond: 'electronics',
    review: [4.1, 0.9, 180],
    themes: ['comfort', 'clarity', 'tracking_accuracy', 'build_quality', 'setup_ease', 'value'],
  },
  tabletop: {
    price: [1900, 39900],
    specs: [
      ['player_count', null, '1-4 players', '2-4 players', '2-6 players', '3-8 players'],
      ['play_time', null, '20 min', '45 min', '90 min', '180 min'],
      ['complexity', null, 'gateway', 'medium weight', 'heavy'],
      ['component_count', null, '120 pieces', '250 pieces', '400 pieces'],
      ['age', null, '8+', '12+', '14+'],
    ],
    titles: 'lot',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.66, 0.29, 0.05],
    cond: 'media',
    review: [4.4, 0.7, 220],
    themes: ['component_quality', 'rules_clarity', 'replayability', 'packaging', 'artwork', 'value'],
  },
  tcg: {
    // Graded singles and sealed product are auction-native: price discovery is
    // public and the bid history is the comparable.
    price: [500, 999900],
    specs: [
      ['set', null, 'base set', 'modern set', 'promo', 'anniversary set'],
      ['grade', null, 'ungraded', 'PSA 9', 'PSA 10', 'BGS 9.5', 'CGC 9'],
      ['rarity', null, 'common', 'rare', 'ultra rare', 'secret rare'],
      ['language', null, 'English', 'Japanese', 'Korean', 'German'],
      ['sealed', null, 'factory sealed', 'resealed', 'opened'],
    ],
    titles: 'lot',
    models: ['{word}', '{A}{N}', '{A}{N}/{N}'],
    mix: [0.28, 0.3, 0.42],
    cond: 'collector',
    review: [4.3, 0.9, 90],
    themes: ['authenticity', 'condition_accuracy', 'grading', 'packaging', 'completeness', 'value'],
  },
  arcade: {
    // Cabinets are restored-and-flipped one at a time; almost nothing here is
    // factory new and freight makes every sale a negotiation.
    price: [9900, 1499900],
    specs: [
      ['cabinet', null, 'upright', 'cocktail', 'cabaret', 'bartop'],
      ['display', null, 'CRT 19 in', 'CRT 25 in', 'LCD 24 in', 'LCD 32 in'],
      ['board', null, 'original PCB', 'multi-game board', 'reproduction'],
      ['playfield', null, 'original playfield', 'restored playfield', 'new old stock'],
      ['coin_mech', null, 'coin op', 'free play', 'switchable'],
    ],
    titles: 'lot',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.2, 0.42, 0.38],
    cond: 'vintage',
    review: [4.3, 0.9, 40],
    themes: ['condition_accuracy', 'restoration_quality', 'authenticity', 'delivery', 'build_quality', 'value'],
  },
  gamingsetup: {
    price: [1900, 129900],
    specs: [
      ['width', 'cm', '100', '120', '140', '160'],
      ['material', null, 'carbon fibre texture', 'tempered glass', 'laminate', 'solid wood'],
      ['lighting', null, 'ARGB', 'RGB', 'no lighting'],
      ['weight_capacity', null, '50 kg', '80 kg', '120 kg'],
      ['mount', null, 'VESA 75x75', 'VESA 100x100', 'desk clamp', 'grommet'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.84, 0.15, 0.01],
    cond: 'gently',
    review: [4.2, 0.9, 260],
    themes: ['assembly', 'stability', 'build_quality', 'cable_management', 'value'],
  },
  gamingcollect: {
    price: [1900, 299900],
    specs: [
      ['scale', null, '1:6', '1:4', '1:1', 'Nendoroid'],
      ['material', null, 'PVC', 'polystone resin', 'cold-cast bronze', 'vinyl'],
      ['edition', null, 'open edition', 'limited to 500', 'limited to 2000', 'convention exclusive'],
      ['certificate', null, 'numbered COA', 'signed COA', 'no COA'],
      ['height', 'cm', '10', '18', '30', '60'],
    ],
    titles: 'lot',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.42, 0.3, 0.28],
    cond: 'collector',
    review: [4.3, 0.9, 80],
    themes: ['paint_quality', 'authenticity', 'packaging', 'condition_accuracy', 'size_accuracy', 'value'],
  },
});

// --- Books and stationery: cheap unit prices, a huge used trade, rare-book auctions.
group('books', {
  fiction: {
    price: [500, 7900],
    specs: [
      ['format', null, 'paperback', 'hardcover', 'trade paperback', 'mass market'],
      ['pages', null, '220', '320', '450', '700'],
      ['language', null, 'English', 'Spanish', 'French', 'German'],
      ['printing', null, 'first printing', 'later printing', 'book club edition'],
      ['signed', null, 'signed', 'signed bookplate', 'unsigned'],
    ],
    titles: 'lot',
    models: ['{word}', 'Vol. {N}', '{word} {N}'],
    mix: [0.55, 0.41, 0.04],
    cond: 'media',
    review: [4.3, 0.8, 340],
    themes: ['print_quality', 'condition_accuracy', 'binding', 'packaging', 'value'],
  },
  nonfiction: {
    price: [700, 9900],
    specs: [
      ['format', null, 'paperback', 'hardcover', 'trade paperback'],
      ['pages', null, '260', '380', '520', '880'],
      ['edition', null, 'first edition', 'revised edition', 'anniversary edition'],
      ['apparatus', null, 'indexed', 'endnotes only', 'no index'],
      ['illustrations', null, 'photo plates', 'line drawings', 'no illustrations'],
    ],
    titles: 'lot',
    models: ['{word}', 'Vol. {N}', '{word} {N}'],
    mix: [0.58, 0.39, 0.03],
    cond: 'media',
    review: [4.3, 0.8, 290],
    themes: ['print_quality', 'condition_accuracy', 'binding', 'packaging', 'value'],
  },
  artbooks: {
    price: [2900, 39900],
    specs: [
      ['format', null, 'hardcover', 'clothbound', 'softcover with slipcase'],
      ['size', 'cm', '21x28', '24x30', '30x40'],
      ['pages', null, '120', '240', '400'],
      ['printing', null, 'offset lithograph', 'four-colour', 'duotone'],
      ['paper', null, 'matte coated', 'uncoated', 'Japanese matte art'],
    ],
    titles: 'lot',
    models: ['{word}', 'Vol. {N}', '{word} {N}'],
    mix: [0.62, 0.33, 0.05],
    cond: 'media',
    review: [4.4, 0.7, 110],
    themes: ['print_quality', 'binding', 'paper_quality', 'packaging', 'condition_accuracy', 'value'],
  },
  rarebooks: {
    // The antiquarian trade is auction-led: edition points and jacket state are
    // argued in public and the hammer price is the comparable.
    price: [4900, 999900],
    specs: [
      ['edition', null, 'true first edition', 'first thus', 'limited edition', 'first UK edition'],
      ['binding', null, "publisher's cloth", 'full morocco', 'half calf', 'original wrappers'],
      ['jacket', null, 'original dust jacket', 'price-clipped jacket', 'facsimile jacket', 'no jacket'],
      ['condition_notes', null, 'near fine', 'foxing', 'bumped corners', 'owner inscription'],
      ['signature', null, 'signed by author', 'inscribed', 'unsigned'],
    ],
    titles: 'lot',
    models: ['{word}', 'Vol. {N}', '{N}'],
    mix: [0.06, 0.44, 0.5],
    cond: 'vintage',
    review: [4.4, 0.8, 35],
    themes: ['condition_accuracy', 'authenticity', 'binding', 'provenance', 'packaging', 'value'],
  },
  notebooks: {
    price: [700, 9900],
    specs: [
      ['pages', null, '96 pages', '128 pages', '192 pages', '240 pages'],
      ['paper_weight', null, '80 gsm', '100 gsm', '120 gsm', '160 gsm'],
      ['ruling', null, 'dot grid', 'lined', 'blank', 'graph'],
      ['size', null, 'A6', 'A5', 'B5', 'A4'],
      ['binding', null, 'thread-bound', 'spiral', 'case bound', 'saddle stitch'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.94, 0.05, 0.01],
    cond: 'nearNew',
    review: [4.4, 0.7, 380],
    themes: ['paper_quality', 'ghosting', 'binding', 'lay_flat', 'packaging', 'value'],
  },
  pens: {
    price: [500, 89900],
    specs: [
      ['nib', null, 'EF', 'F', 'M', 'B', 'stub 1.1'],
      ['nib_material', null, 'stainless steel', '14k gold', '18k gold', 'titanium'],
      ['filling', null, 'cartridge converter', 'piston', 'vacuum', 'eyedropper'],
      ['body_material', null, 'resin', 'ebonite', 'brass', 'celluloid'],
      ['volume', 'ml', '2', '5', '30', '50'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{word}'],
    mix: [0.72, 0.25, 0.03],
    cond: 'gently',
    review: [4.4, 0.7, 240],
    themes: ['nib_smoothness', 'ink_flow', 'build_quality', 'grip', 'packaging', 'value'],
  },
  deskstationery: {
    price: [500, 19900],
    specs: [
      ['material', null, 'powder-coated steel', 'solid walnut', 'acrylic', 'wool felt'],
      ['capacity', null, '2 tiers', '3 tiers', '5 compartments'],
      ['size', 'cm', '15x20', '22x30', '30x40'],
      ['finish', null, 'matte', 'brushed', 'oiled', 'anodised'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.93, 0.06, 0.01],
    cond: 'gently',
    review: [4.2, 0.8, 220],
    themes: ['build_quality', 'finish_quality', 'capacity', 'packaging', 'value'],
  },
  paper: {
    price: [300, 9900],
    specs: [
      ['paper_weight', null, '90 gsm', '120 gsm', '250 gsm', '300 gsm'],
      ['sheets', null, '25 sheets', '50 sheets', '100 sheets'],
      ['size', null, 'A6', 'A5', 'A4', '4x6 in'],
      ['finish', null, 'uncoated', 'laid', 'cotton rag', 'vellum'],
      ['pack_size', null, 'single', '10-pack', '24-pack'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.95, 0.04, 0.01],
    cond: 'nearNew',
    review: [4.2, 0.8, 190],
    themes: ['paper_quality', 'print_quality', 'packaging', 'colour_accuracy', 'value'],
  },
  calligraphy: {
    price: [500, 24900],
    specs: [
      ['nib', null, 'Nikko G', 'Brause 361', 'Leonardt Principal', 'brush tip'],
      ['ink_type', null, 'iron gall', 'sumi', 'acrylic', 'walnut'],
      ['volume', 'ml', '15', '30', '60'],
      ['holder', null, 'straight holder', 'oblique holder', 'adjustable flange'],
      ['set_size', null, '3-piece', '6-piece', '12-piece'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.93, 0.06, 0.01],
    cond: 'gently',
    review: [4.3, 0.8, 140],
    themes: ['ink_flow', 'nib_smoothness', 'ease_of_use', 'packaging', 'value'],
  },
  comics: {
    // Slabbed key issues clear at auction; reading copies do not.
    price: [500, 499900],
    specs: [
      ['grade', null, 'ungraded', 'CGC 9.4', 'CGC 9.8', 'CBCS 9.6'],
      ['age', null, 'Golden Age', 'Silver Age', 'Bronze Age', 'Modern'],
      ['format', null, 'single issue', 'trade paperback', 'omnibus', 'manga volume'],
      ['printing', null, 'first print', 'second print', 'variant cover'],
      ['language', null, 'English', 'Japanese', 'French'],
    ],
    titles: 'lot',
    models: ['#{N}', 'Vol. {N}', '{word} {N}'],
    mix: [0.4, 0.34, 0.26],
    cond: 'collector',
    review: [4.3, 0.9, 95],
    themes: ['condition_accuracy', 'grading', 'print_quality', 'packaging', 'authenticity', 'value'],
  },
});

// --- Art and collectibles: the one L1 where auction is the dominant channel,
// because provenance and scarcity are priced by bidding, not by list price.
group('art', {
  prints: {
    price: [4900, 499900],
    specs: [
      ['edition_size', null, 'edition of 25', 'edition of 50', 'edition of 100', 'open edition'],
      ['technique', null, 'screen print', 'giclée', 'lithograph', 'etching', 'risograph'],
      ['paper', null, 'Somerset Satin', 'Hahnemühle rag', 'Coventry Rag', 'newsprint'],
      ['size', 'cm', '30x40', '50x70', '70x100'],
      ['signature', null, 'signed and numbered', 'plate signed', 'unsigned'],
    ],
    titles: 'lot',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.42, 0.22, 0.36],
    cond: 'collector',
    review: [4.4, 0.8, 55],
    themes: ['print_quality', 'colour_accuracy', 'condition_accuracy', 'framing', 'packaging', 'authenticity'],
  },
  originalart: {
    price: [9900, 2999900],
    specs: [
      ['medium', null, 'oil on canvas', 'acrylic on board', 'watercolour on paper', 'mixed media'],
      ['size', 'cm', '20x25', '40x50', '80x100', '120x150'],
      ['framing', null, 'unframed', 'gallery frame', 'float frame', 'stretched only'],
      ['year', null, '1970s', '1990s', '2010s', '2020s'],
      ['provenance', null, 'direct from artist', 'gallery provenance', 'estate', 'private collection'],
    ],
    titles: 'lot',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.3, 0.16, 0.54],
    cond: 'collector',
    review: [4.4, 0.8, 30],
    themes: ['authenticity', 'provenance', 'condition_accuracy', 'colour_accuracy', 'framing', 'packaging'],
  },
  sculpture: {
    price: [7900, 1999900],
    specs: [
      ['material', null, 'stoneware', 'cast bronze', 'hand-blown glass', 'carved oak', 'resin'],
      ['height', 'cm', '15', '30', '60', '120'],
      ['weight', 'g', '800', '2500', '9000', '24000'],
      ['edition', null, 'unique piece', 'edition of 8', 'edition of 25'],
      ['finish', null, 'wood-fired glaze', 'patinated', 'polished', 'raw'],
    ],
    titles: 'lot',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.36, 0.18, 0.46],
    cond: 'collector',
    review: [4.4, 0.8, 28],
    themes: ['authenticity', 'condition_accuracy', 'finish_quality', 'packaging', 'delivery', 'provenance'],
  },
  photoart: {
    price: [4900, 999900],
    specs: [
      ['process', null, 'silver gelatin', 'chromogenic C-print', 'platinum palladium', 'inkjet pigment'],
      ['size', 'cm', '20x25', '40x50', '60x90'],
      ['edition', null, 'edition of 5', 'edition of 15', 'edition of 50', 'vintage print'],
      ['mounting', null, 'unmounted', 'dibond mounted', 'museum board'],
      ['signature', null, 'signed verso', 'signed recto', 'estate stamped'],
    ],
    titles: 'lot',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.34, 0.2, 0.46],
    cond: 'collector',
    review: [4.4, 0.8, 32],
    themes: ['authenticity', 'print_quality', 'condition_accuracy', 'provenance', 'framing', 'packaging'],
  },
  designobjects: {
    price: [9900, 1499900],
    specs: [
      ['period', null, '1950s', '1960s', '1970s', '1980s'],
      ['attribution', null, 'documented', 'attributed', 'signed', 'unattributed'],
      ['material', null, 'rosewood', 'chromed steel', 'Murano glass', 'moulded plywood'],
      ['restoration', null, 'original condition', 'professionally restored', 'reupholstered'],
      ['origin', null, 'Denmark', 'Italy', 'Germany', 'Japan'],
    ],
    titles: 'lot',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.2, 0.32, 0.48],
    cond: 'vintage',
    review: [4.3, 0.9, 30],
    themes: ['authenticity', 'condition_accuracy', 'restoration_quality', 'provenance', 'delivery', 'value'],
  },
  antiques: {
    price: [4900, 1999900],
    specs: [
      ['period', null, 'Georgian', 'Victorian', 'Edwardian', 'Art Deco'],
      ['material', null, 'mahogany', 'sterling silver', 'brass', 'porcelain'],
      ['hallmark', null, 'fully hallmarked', 'part marked', 'unmarked'],
      ['restoration', null, 'untouched', 'sympathetically restored', 'later repairs'],
      ['provenance', null, 'country house sale', 'private collection', 'dealer stock', 'estate'],
    ],
    titles: 'lot',
    models: ['{word}', '{word} {N}', '{N}'],
    mix: [0.12, 0.3, 0.58],
    cond: 'vintage',
    review: [4.3, 0.9, 25],
    themes: ['authenticity', 'condition_accuracy', 'provenance', 'restoration_quality', 'packaging', 'value'],
  },
  coins: {
    price: [1900, 999900],
    specs: [
      ['grade', null, 'MS-63', 'MS-65', 'AU-58', 'PF-69', 'ungraded'],
      ['holder', null, 'PCGS slab', 'NGC slab', 'raw'],
      ['metal', null, 'gold', 'silver', 'copper', 'bimetallic'],
      ['year', null, '1878', '1921', '1964', '1986', '2021'],
      ['mint', null, 'Philadelphia', 'San Francisco', 'Royal Mint', 'Perth Mint'],
    ],
    titles: 'lot',
    models: ['{N}', '{word} {N}', '{A}{N}'],
    mix: [0.22, 0.22, 0.56],
    cond: 'collector',
    review: [4.4, 0.8, 40],
    themes: ['grading', 'authenticity', 'condition_accuracy', 'packaging', 'provenance', 'value'],
  },
  stamps: {
    price: [500, 499900],
    specs: [
      ['gum', null, 'mint never hinged', 'lightly hinged', 'used', 'no gum'],
      ['perforation', null, 'perf 11', 'perf 12.5', 'imperforate'],
      ['certification', null, 'expert certificate', 'dealer guarantee', 'unexpertised'],
      ['centring', null, 'superb', 'fine', 'off-centre'],
      ['era', null, 'classic', 'pre-1940', 'modern'],
    ],
    titles: 'lot',
    models: ['{word} {N}', '{N}', '{A}{N}'],
    mix: [0.16, 0.26, 0.58],
    cond: 'collector',
    review: [4.3, 0.9, 25],
    themes: ['authenticity', 'condition_accuracy', 'grading', 'packaging', 'provenance', 'value'],
  },
  memorabilia: {
    price: [1900, 999900],
    specs: [
      ['signature', null, 'signed in person', 'certified autograph', 'secretarial', 'unsigned'],
      ['certification', null, 'PSA/DNA', 'Beckett', 'JSA', 'no COA'],
      ['era', null, '1960s', '1970s', '1980s', '1990s', '2000s'],
      ['format', null, 'poster', 'garment', 'photograph', 'document'],
      ['condition_notes', null, 'near mint', 'pin holes', 'fold lines', 'tape residue'],
    ],
    titles: 'lot',
    models: ['{word}', '{word} {N}', '{N}'],
    mix: [0.18, 0.26, 0.56],
    cond: 'vintage',
    review: [4.2, 1.0, 35],
    themes: ['authenticity', 'provenance', 'condition_accuracy', 'packaging', 'grading', 'value'],
  },
  artsupplies: {
    // The one L2 in this L1 that is ordinary retail: consumables, not objects.
    price: [500, 39900],
    specs: [
      ['volume', 'ml', '20', '37', '60', '200'],
      ['pigment', null, 'single pigment', 'hue', 'student grade', 'professional grade'],
      ['lightfastness', null, 'ASTM I', 'ASTM II', 'ASTM III'],
      ['size', 'cm', '20x25', '40x50', '60x80'],
      ['bristle', null, 'hog bristle', 'sable', 'synthetic', 'squirrel'],
    ],
    titles: 'consumable',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.94, 0.05, 0.01],
    cond: 'gently',
    review: [4.3, 0.8, 260],
    themes: ['pigment_quality', 'colour_accuracy', 'ease_of_use', 'packaging', 'value'],
  },
});

// --- Photography: bodies depreciate fast, glass holds value, film gear is vintage.
group('photography', {
  mirrorless: {
    price: [39900, 899900],
    specs: [
      ['sensor', null, 'full-frame', 'APS-C', 'micro four thirds', 'medium format'],
      ['resolution', null, '24 MP', '33 MP', '45 MP', '61 MP', '100 MP'],
      ['mount', null, 'E-mount', 'RF', 'Z', 'L-mount', 'X'],
      ['stabilisation', null, '5-axis IBIS', '8-stop IBIS', 'no IBIS'],
      ['video', null, '4K60', '6K ProRes', '8K30'],
      ['shutter_count', null, 'under 5k', '10k-30k', '50k+'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{A}{N}-{A}', '{A}{N} Mark {N}'],
    mix: [0.52, 0.44, 0.04],
    cond: 'electronics',
    review: [4.5, 0.6, 180],
    themes: ['image_quality', 'autofocus', 'build_quality', 'ergonomics', 'battery_life', 'shutter_count'],
  },
  dslr: {
    // A format in run-off: new stock is scarce, so the used trade is the market.
    price: [9900, 449900],
    specs: [
      ['sensor', null, 'full-frame', 'APS-C'],
      ['resolution', null, '18 MP', '24 MP', '30 MP', '50 MP'],
      ['mount', null, 'EF', 'F-mount', 'K-mount'],
      ['shutter_count', null, 'under 10k', '30k-80k', '150k+'],
      ['viewfinder', null, 'pentaprism 100%', 'pentaprism 95%', 'pentamirror'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{A}{N}{A}', '{A}{N} Mark {N}'],
    mix: [0.22, 0.72, 0.06],
    cond: 'electronics',
    review: [4.4, 0.7, 140],
    themes: ['image_quality', 'shutter_count', 'condition_accuracy', 'autofocus', 'ergonomics', 'value'],
  },
  filmcameras: {
    // Nothing here is manufactured any more, and unserviced bodies carry real
    // risk, so listings live or die on how honestly condition is described.
    price: [4900, 799900],
    specs: [
      ['format', null, '35mm', '120 medium format', '4x5 large format', 'instant'],
      ['shutter', null, 'leaf shutter', 'focal plane', 'electronic'],
      ['metering', null, 'match needle', 'centre-weighted', 'no meter'],
      ['service', null, 'recently serviced', 'seals replaced', 'untested', 'sold as-is'],
      ['lens_mount', null, 'M42', 'Leica M', 'Nikon F', 'Hasselblad V'],
    ],
    titles: 'lot',
    models: ['{A}{N}', '{word} {N}', '{A}{N}{A}'],
    mix: [0.06, 0.64, 0.3],
    cond: 'vintage',
    review: [4.2, 1.0, 60],
    themes: ['condition_accuracy', 'service_history', 'light_seals', 'shutter_accuracy', 'authenticity', 'value'],
  },
  lenses: {
    price: [9900, 899900],
    specs: [
      ['focal_length', null, '24mm', '35mm', '50mm', '85mm', '70-200mm'],
      ['aperture', null, 'f/1.2', 'f/1.4', 'f/1.8', 'f/2.8', 'f/4'],
      ['mount', null, 'E-mount', 'RF', 'Z', 'EF', 'M42'],
      ['filter_thread', 'mm', '49', '52', '67', '77', '82'],
      ['stabilisation', null, 'optical stabilisation', 'no stabilisation'],
      ['weight', 'g', '280', '480', '900', '1450'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{A}{N}-{N}', '{A}{N}{A}'],
    mix: [0.48, 0.46, 0.06],
    cond: 'electronics',
    review: [4.5, 0.6, 210],
    themes: ['sharpness', 'bokeh', 'autofocus', 'build_quality', 'chromatic_aberration', 'value'],
  },
  photolighting: {
    price: [4900, 249900],
    specs: [
      ['power', null, '200 Ws', '400 Ws', '600 Ws', '1200 Ws'],
      ['colour_temperature', null, '3200K', '5600K', 'bi-colour', 'RGB'],
      ['recycle_time', null, '0.05-1.2 s', '0.1-0.9 s', '1.5 s'],
      ['mount', null, 'Bowens mount', 'Profoto mount', 'speedlight shoe'],
      ['size', 'cm', '60x60', '90x90', '120 octa'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{A}{N}-{N}'],
    mix: [0.72, 0.26, 0.02],
    cond: 'electronics',
    review: [4.3, 0.8, 120],
    themes: ['build_quality', 'colour_accuracy', 'recycle_time', 'portability', 'reliability', 'value'],
  },
  support: {
    price: [3900, 199900],
    specs: [
      ['max_load', null, '8 kg', '15 kg', '25 kg', '40 kg'],
      ['material', null, 'carbon fibre', 'aluminium', 'basalt'],
      ['folded_length', 'cm', '38', '45', '55', '70'],
      ['head', null, 'ball head', 'three-way head', 'fluid head', 'gimbal head'],
      ['sections', null, '3-section', '4-section', '5-section'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{A}{N}-{N}', '{word} {N}'],
    mix: [0.74, 0.24, 0.02],
    cond: 'hardUse',
    review: [4.3, 0.8, 160],
    themes: ['stability', 'build_quality', 'weight', 'ease_of_use', 'portability', 'value'],
  },
  darkroom: {
    price: [900, 129900],
    specs: [
      ['iso', null, '100', '200', '400', '800', '3200'],
      ['format', null, '35mm 36exp', '120 roll', '4x5 sheet', 'instant pack'],
      ['process', null, 'C-41', 'E-6', 'black and white', 'ECN-2'],
      ['expiry', null, 'fresh dated', 'expired 2019', 'expired 2005', 'frozen storage'],
      ['enlarger_format', null, '35mm', '6x6', '4x5'],
    ],
    titles: 'consumable',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.72, 0.24, 0.04],
    cond: 'media',
    review: [4.3, 0.8, 180],
    themes: ['consistency', 'freshness', 'grain', 'packaging', 'value'],
  },
  camerabags: {
    price: [3900, 79900],
    specs: [
      ['capacity', 'L', '8', '16', '24', '32'],
      ['laptop_fit', 'in', '13', '14', '15', '16'],
      ['material', null, '500D nylon', 'X-Pac', 'waxed canvas', 'ballistic nylon'],
      ['access', null, 'rear access', 'side access', 'top access', 'clamshell'],
      ['dividers', null, '3 dividers', '5 dividers', 'modular cube'],
    ],
    titles: 'apparel',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.8, 0.19, 0.01],
    cond: 'apparel',
    review: [4.3, 0.8, 190],
    themes: ['capacity', 'organisation', 'comfort', 'weather_resistance', 'build_quality', 'value'],
  },
  filters: {
    price: [1200, 49900],
    specs: [
      ['filter_thread', 'mm', '49', '52', '58', '67', '77', '82'],
      ['density', null, 'ND8', 'ND64', 'ND1000', 'variable ND'],
      ['coating', null, 'nano multi-coated', 'multi-coated', 'uncoated'],
      ['glass', null, 'Schott B270', 'Corning Gorilla', 'optical resin'],
      ['frame', null, 'brass frame', 'aluminium frame', 'magnetic frame'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{A}{N}-{N}'],
    mix: [0.86, 0.13, 0.01],
    cond: 'gently',
    review: [4.3, 0.8, 230],
    themes: ['colour_cast', 'sharpness', 'build_quality', 'flare_control', 'packaging', 'value'],
  },
  videoaccessories: {
    price: [4900, 399900],
    specs: [
      ['resolution', null, '1920x1080', '2560x1440', '3840x2160'],
      ['brightness', null, '1000 nits', '1500 nits', '2200 nits'],
      ['recording', null, 'ProRes', 'BRAW', 'H.265'],
      ['power', null, 'NP-F battery', 'V-mount', 'D-tap'],
      ['connection', null, 'HDMI 2.0', 'SDI', 'USB-C', 'XLR'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{A}{N}-{N}', '{word} {N}'],
    mix: [0.7, 0.28, 0.02],
    cond: 'electronics',
    review: [4.3, 0.8, 110],
    themes: ['build_quality', 'brightness', 'heat', 'connectivity', 'battery_life', 'value'],
  },
});

// --- Auto and moto: fitment is the buying decision; whole vehicles skew private.
group('auto', {
  carparts: {
    price: [2900, 499900],
    specs: [
      ['fitment', null, 'BMW E46', 'Honda Civic EK', 'VW Golf Mk7', 'Subaru WRX', 'universal'],
      ['material', null, 'cast iron', 'forged aluminium', '304 stainless', 'carbon fibre'],
      ['diameter', 'mm', '280', '330', '355', '380'],
      ['position', null, 'front axle', 'rear axle', 'full kit'],
      ['certification', null, 'TÜV approved', 'DOT compliant', 'track use only'],
    ],
    titles: 'fitment',
    models: ['{A}{N}', '{A}{N}-{N}', '{word} {N}'],
    mix: [0.66, 0.31, 0.03],
    cond: 'mechanical',
    review: [4.2, 0.9, 170],
    themes: ['fitment', 'build_quality', 'installation', 'durability', 'instructions', 'value'],
  },
  wheelstyres: {
    price: [4900, 299900],
    specs: [
      ['size', 'in', '16', '17', '18', '19', '20'],
      ['width', null, '7.5J', '8.5J', '9.5J', '10J'],
      ['offset', null, 'ET20', 'ET35', 'ET45'],
      ['bolt_pattern', null, '5x100', '5x112', '5x114.3', '4x100'],
      ['tread_size', null, '225/45R17', '245/40R18', '255/35R19'],
    ],
    titles: 'fitment',
    models: ['{A}{N}', '{word} {N}', '{A}{N}-{N}'],
    mix: [0.72, 0.26, 0.02],
    cond: 'mechanical',
    review: [4.2, 0.9, 190],
    themes: ['fitment', 'balance', 'road_noise', 'wet_grip', 'durability', 'value'],
  },
  carinterior: {
    price: [1900, 199900],
    specs: [
      ['fitment', null, 'universal', 'vehicle-specific', 'BMW E9x', 'Toyota GR86'],
      ['material', null, 'alcantara', 'nappa leather', 'TPE rubber', 'moulded carpet'],
      ['mounting', null, 'OEM bracket', 'suction mount', 'vent clip', 'bolt-in'],
      ['resolution', null, '1080p', '1440p', '4K'],
      ['finish', null, 'black', 'tan', 'grey', 'red stitch'],
    ],
    titles: 'fitment',
    models: ['{A}{N}', '{word} {N}', '{A}{N}-{N}'],
    mix: [0.82, 0.17, 0.01],
    cond: 'gently',
    review: [4.1, 0.9, 260],
    themes: ['fitment', 'installation', 'build_quality', 'materials', 'value'],
  },
  carelectronics: {
    price: [2900, 199900],
    specs: [
      ['screen_size', 'in', '7', '9', '10.1'],
      ['power', 'W', '50', '75', '150', '600'],
      ['impedance', null, '1 ohm stable', '2 ohm', '4 ohm'],
      ['channels', null, 'mono', '2-channel', '4-channel', '5-channel'],
      ['connectivity', null, 'CarPlay', 'Android Auto', 'bluetooth', 'wired USB'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{A}{N}-{N}', '{word} {N}'],
    mix: [0.8, 0.19, 0.01],
    cond: 'electronics',
    review: [4.1, 1.0, 220],
    themes: ['installation', 'sound_quality', 'instructions', 'reliability', 'connectivity', 'value'],
  },
  garagetools: {
    price: [1900, 199900],
    specs: [
      ['capacity', null, '2 ton', '3 ton', '5 ton'],
      ['drive', null, '1/4 in', '3/8 in', '1/2 in'],
      ['torque_range', null, '20-100 Nm', '40-200 Nm', '70-350 Nm'],
      ['set_size', null, '72-piece', '108-piece', '216-piece'],
      ['power', 'W', '1100', '1500', '2200'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{A}{N}-{N}'],
    mix: [0.8, 0.19, 0.01],
    cond: 'hardUse',
    review: [4.4, 0.7, 240],
    themes: ['build_quality', 'accuracy', 'case_quality', 'durability', 'ergonomics', 'value'],
  },
  detailing: {
    price: [900, 39900],
    specs: [
      ['volume', 'ml', '100', '250', '500', '1000'],
      ['durability', null, '6 months', '12 months', '3 years', '5 years'],
      ['finish', null, 'gloss', 'matte', 'satin'],
      ['applicator', null, 'foam block', 'microfibre', 'spray', 'machine pad'],
      ['pile_weight', null, '350 gsm', '500 gsm', '1200 gsm'],
    ],
    titles: 'consumable',
    models: ['{A}{N}', '{word} {N}', '{word}'],
    mix: [0.95, 0.04, 0.01],
    cond: 'nearNew',
    review: [4.3, 0.8, 340],
    themes: ['effectiveness', 'durability', 'ease_of_use', 'smell', 'value'],
  },
  motoparts: {
    price: [2900, 299900],
    specs: [
      ['fitment', null, 'Yamaha MT-07', 'Honda CB650R', 'Ducati Monster', 'universal'],
      ['material', null, 'titanium', '304 stainless', 'forged aluminium', 'carbon fibre'],
      ['gearing', null, '15T front', '45T rear', '520 chain'],
      ['certification', null, 'road legal', 'track only', 'E-marked'],
      ['finish', null, 'anodised', 'brushed', 'ceramic coated'],
    ],
    titles: 'fitment',
    models: ['{A}{N}', '{A}{N}-{N}', '{word} {N}'],
    mix: [0.7, 0.28, 0.02],
    cond: 'mechanical',
    review: [4.3, 0.8, 140],
    themes: ['fitment', 'build_quality', 'installation', 'durability', 'noise', 'value'],
  },
  motogear: {
    price: [4900, 149900],
    specs: [
      ['size', null, 'S', 'M', 'L', 'XL', 'XXL'],
      ['certification', null, 'ECE 22.06', 'SNELL', 'CE Level 2', 'DOT'],
      ['shell', null, 'fibreglass composite', 'carbon fibre', 'polycarbonate'],
      ['armour', null, 'CE Level 1', 'CE Level 2', 'back protector included'],
      ['material', null, 'cowhide leather', '600D textile', 'kangaroo leather', 'mesh'],
    ],
    titles: 'apparel',
    models: ['{A}{N}', '{word} {N}', '{word}'],
    mix: [0.86, 0.13, 0.01],
    cond: 'apparel',
    review: [4.3, 0.8, 200],
    themes: ['sizing', 'ventilation', 'noise', 'comfort', 'protection', 'value'],
  },
  motorcycles: {
    // Whole vehicles: private sale dominates and the classic end runs through
    // enthusiast auction houses, so there is barely a "new" channel here.
    price: [199900, 4999900],
    specs: [
      ['engine_capacity', null, '125 cc', '390 cc', '650 cc', '900 cc', '1200 cc'],
      ['mileage', null, 'under 3k mi', '8k mi', '20k mi', '45k mi'],
      ['service', null, 'full service history', 'recent major service', 'no history'],
      ['year', null, '1978', '1996', '2012', '2019', '2023'],
      ['title', null, 'clean title', 'salvage title', 'non-op', 'import papers'],
    ],
    titles: 'lot',
    models: ['{A}{N}', '{word} {N}', '{A}{N}-{N}'],
    mix: [0.18, 0.52, 0.3],
    cond: 'mechanical',
    review: [4.3, 0.9, 35],
    themes: ['service_history', 'condition_accuracy', 'mileage', 'mechanical_condition', 'authenticity', 'value'],
  },
  automobilia: {
    price: [1900, 999900],
    specs: [
      ['era', null, '1930s', '1950s', '1960s', '1970s'],
      ['material', null, 'porcelain enamel', 'pressed tin', 'die-cast zinc', 'lithographed paper'],
      ['scale', null, '1:8', '1:18', '1:43', '1:64'],
      ['authenticity', null, 'period original', 'licensed reproduction', 'restored', 'unknown'],
      ['size', 'cm', '20x30', '45x60', '90x120'],
    ],
    titles: 'lot',
    models: ['{word}', '{word} {N}', '{N}'],
    mix: [0.24, 0.28, 0.48],
    cond: 'vintage',
    review: [4.2, 0.9, 40],
    themes: ['authenticity', 'condition_accuracy', 'provenance', 'restoration_quality', 'packaging', 'value'],
  },
});

// --- Pets: consumables and hygiene goods, so resale is close to nonexistent.
group('pets', {
  dogfood: {
    price: [700, 19900],
    specs: [
      ['weight', 'g', '2000', '5000', '12000', '15000'],
      ['protein', null, 'chicken', 'salmon', 'lamb', 'turkey', 'insect protein'],
      ['life_stage', null, 'puppy', 'adult', 'senior', 'all life stages'],
      ['format', null, 'kibble', 'wet', 'freeze-dried raw', 'air-dried'],
      ['protein_content', null, '24%', '30%', '38%'],
    ],
    titles: 'consumable',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.98, 0.02, 0.0],
    cond: 'nearNew',
    review: [4.3, 0.9, 680],
    themes: ['palatability', 'ingredient_quality', 'digestion', 'packaging', 'value'],
  },
  dogwalking: {
    price: [900, 19900],
    specs: [
      ['size', null, 'XS', 'S', 'M', 'L', 'XL'],
      ['material', null, 'nylon webbing', 'biothane', 'bridle leather', 'ripstop'],
      ['length', null, '1.2 m', '1.8 m', '3 m', '10 m'],
      ['attachment', null, 'front clip', 'back clip', 'dual clip'],
      ['closure', null, 'side-release buckle', 'metal buckle', 'step-in'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.94, 0.05, 0.01],
    cond: 'gently',
    review: [4.3, 0.8, 420],
    themes: ['sizing', 'durability', 'hardware_quality', 'escape_resistance', 'comfort', 'value'],
  },
  dogcomfort: {
    price: [1900, 39900],
    specs: [
      ['size', 'cm', '60x45', '90x60', '120x80'],
      ['material', null, 'memory foam', 'orthopaedic foam', 'polyester fill', 'cooling gel'],
      ['cover', null, 'removable washable cover', 'waterproof liner', 'fixed cover'],
      ['crate_size', null, '24 in', '30 in', '36 in', '42 in'],
      ['weight_range', null, 'up to 10 kg', '10-25 kg', '25-45 kg'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.92, 0.07, 0.01],
    cond: 'gently',
    review: [4.2, 0.9, 380],
    themes: ['durability', 'cleaning', 'comfort', 'size_accuracy', 'odour', 'value'],
  },
  dogtoys: {
    price: [500, 9900],
    specs: [
      ['material', null, 'natural rubber', 'cotton rope', 'nylon', 'plush'],
      ['size', null, 'small', 'medium', 'large'],
      ['chew_rating', null, 'gentle chewer', 'moderate chewer', 'power chewer'],
      ['feature', null, 'treat dispensing', 'squeaker', 'floats', 'freezable'],
      ['difficulty', null, 'level 1', 'level 2', 'level 3'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.96, 0.03, 0.01],
    cond: 'nearNew',
    review: [4.1, 1.0, 540],
    themes: ['durability', 'engagement', 'noise', 'cleaning', 'value'],
  },
  catessentials: {
    price: [900, 49900],
    specs: [
      ['capacity', 'L', '6', '10', '20'],
      ['material', null, 'recycled plastic', 'stainless steel', 'bentonite clay', 'tofu pellet'],
      ['clumping', null, 'clumping', 'non-clumping', 'crystal'],
      ['entry', null, 'top entry', 'front entry', 'open pan'],
      ['dust', null, 'dust-free', 'low dust', 'standard'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.96, 0.03, 0.01],
    cond: 'nearNew',
    review: [4.1, 1.0, 460],
    themes: ['odour', 'dust', 'cleaning', 'tracking', 'value'],
  },
  catfurniture: {
    price: [2900, 49900],
    specs: [
      ['height', 'cm', '60', '120', '160', '200'],
      ['material', null, 'sisal rope', 'corrugated cardboard', 'solid pine', 'plush fabric'],
      ['platforms', null, '3 platforms', '5 platforms', '7 platforms'],
      ['weight_capacity', null, 'up to 7 kg', 'up to 12 kg', 'multi-cat'],
      ['mounting', null, 'freestanding', 'wall-mounted', 'window suction'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.92, 0.07, 0.01],
    cond: 'gently',
    review: [4.2, 0.9, 290],
    themes: ['stability', 'assembly', 'durability', 'size_accuracy', 'value'],
  },
  cattoys: {
    price: [400, 7900],
    specs: [
      ['material', null, 'natural feather', 'sisal', 'silvervine', 'recycled plastic'],
      ['power', null, 'battery powered', 'manual', 'USB rechargeable'],
      ['refill', null, 'refillable catnip', 'sealed', 'no catnip'],
      ['size', 'cm', '8', '15', '30', '60'],
      ['sound', null, 'silent', 'rattle', 'bell'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.96, 0.03, 0.01],
    cond: 'nearNew',
    review: [4.0, 1.0, 410],
    themes: ['engagement', 'durability', 'noise', 'safety', 'value'],
  },
  smallpets: {
    price: [1200, 39900],
    specs: [
      ['size', 'cm', '80x50', '120x60', '150x80'],
      ['material', null, 'powder-coated wire', 'solid pine', 'moulded plastic', 'chew-proof mesh'],
      ['bar_spacing', 'mm', '8', '10', '12'],
      ['bedding_type', null, 'paper bedding', 'hemp', 'aspen shaving', 'fleece liner'],
      ['wheel_diameter', 'cm', '20', '28', '30'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.94, 0.05, 0.01],
    cond: 'gently',
    review: [4.1, 1.0, 230],
    themes: ['assembly', 'size_accuracy', 'cleaning', 'durability', 'safety', 'value'],
  },
  aquarium: {
    price: [1900, 129900],
    specs: [
      ['volume', 'L', '20', '60', '120', '240'],
      ['glass', null, 'low-iron glass', 'standard float glass', 'acrylic'],
      ['flow_rate', null, '300 L/h', '900 L/h', '1500 L/h'],
      ['power', 'W', '50', '100', '200', '300'],
      ['spectrum', null, 'full spectrum', 'plant spectrum', 'marine spectrum'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{A}{N}-{N}'],
    mix: [0.9, 0.09, 0.01],
    cond: 'gently',
    review: [4.2, 0.9, 260],
    themes: ['build_quality', 'noise', 'flow_rate', 'reliability', 'setup_ease', 'value'],
  },
  petgrooming: {
    price: [900, 29900],
    specs: [
      ['blade', null, 'stainless steel', 'ceramic', 'titanium-coated'],
      ['runtime', null, '90 min', '150 min', '240 min'],
      ['coat_type', null, 'short coat', 'double coat', 'curly coat', 'wiry coat'],
      ['volume', 'ml', '250', '500', '1000'],
      ['teeth', null, 'fine teeth', 'medium teeth', 'coarse teeth'],
    ],
    titles: 'tech',
    models: ['{A}{N}', '{word} {N}', '{word}'],
    mix: [0.94, 0.05, 0.01],
    cond: 'nearNew',
    review: [4.1, 1.0, 380],
    themes: ['effectiveness', 'noise', 'build_quality', 'ease_of_use', 'value'],
  },
});

// --- Kids and baby: outgrown fast, so resale exists — except where safety bars it.
group('kids', {
  strollers: {
    price: [7900, 149900],
    specs: [
      ['weight', 'g', '5800', '7200', '9500', '12000'],
      ['fold', null, 'one-hand fold', 'compact fold', 'umbrella fold'],
      ['age_range', null, 'birth to 4 years', '6 months to 4 years', 'birth to 22 kg'],
      ['configuration', null, 'carrycot included', 'seat only', 'full travel system'],
      ['wheels', null, 'air-filled', 'foam-filled', 'all-terrain'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.72, 0.27, 0.01],
    cond: 'gently',
    review: [4.3, 0.8, 310],
    themes: ['fold_ease', 'manoeuvrability', 'weight', 'build_quality', 'storage_capacity', 'value'],
  },
  carseats: {
    // Expiry dates and unverifiable crash history make used seats unsellable —
    // the purest all-new L2 in the taxonomy.
    price: [9900, 69900],
    specs: [
      ['orientation', null, 'rear-facing', 'forward-facing', 'rotating'],
      ['weight_range', null, '0-13 kg', '9-18 kg', '15-36 kg'],
      ['installation', null, 'ISOFIX', 'i-Size base', 'seatbelt install'],
      ['certification', null, 'i-Size R129', 'ECE R44/04'],
      ['side_impact', null, 'SIP pods', 'reinforced headrest', 'energy-absorbing foam'],
    ],
    titles: 'tech',
    models: ['{word} {N}', '{A}{N}', '{word}'],
    mix: [0.98, 0.02, 0.0],
    cond: 'nearNew',
    review: [4.5, 0.6, 420],
    themes: ['installation', 'safety', 'comfort', 'fit_accuracy', 'build_quality', 'value'],
  },
  nursery: {
    price: [4900, 149900],
    specs: [
      ['material', null, 'solid beech', 'lacquered MDF', 'rattan', 'powder-coated steel'],
      ['conversion', null, 'cot only', 'converts to toddler bed', '4-in-1 convertible'],
      ['mattress_size', 'cm', '60x120', '70x140'],
      ['range', null, '250 m', '300 m', 'Wi-Fi app'],
      ['adjustment', null, '3 height positions', '4 height positions', 'fixed'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.86, 0.13, 0.01],
    cond: 'gently',
    review: [4.3, 0.8, 270],
    themes: ['assembly', 'build_quality', 'safety', 'materials', 'size_accuracy', 'value'],
  },
  feeding: {
    price: [900, 49900],
    specs: [
      ['volume', 'ml', '120', '150', '260', '330'],
      ['material', null, 'borosilicate glass', 'PP plastic', 'medical silicone', 'stainless steel'],
      ['flow', null, 'slow flow', 'medium flow', 'variable flow'],
      ['age', null, '0-3 months', '3-6 months', '6+ months'],
      ['power', 'W', '400', '600', '1100'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.95, 0.05, 0.0],
    cond: 'nearNew',
    review: [4.2, 0.9, 490],
    themes: ['cleaning', 'leaking', 'ease_of_use', 'materials', 'value'],
  },
  babyclothes: {
    price: [700, 12900],
    specs: [
      ['size', null, 'Newborn', '0-3m', '3-6m', '6-12m', '12-18m'],
      ['fabric', null, 'GOTS organic cotton', 'merino wool', 'bamboo viscose', 'cotton rib'],
      ['closure', null, 'poppers', 'two-way zip', 'envelope neck', 'magnetic'],
      ['tog', null, '0.5 tog', '1.0 tog', '2.5 tog'],
      ['pack_size', null, 'single', '3-pack', '5-pack'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.78, 0.21, 0.01],
    cond: 'apparel',
    review: [4.3, 0.8, 340],
    themes: ['sizing', 'fabric_quality', 'shrinkage', 'ease_of_use', 'durability', 'value'],
  },
  kidsclothes: {
    price: [900, 19900],
    specs: [
      ['size', null, '2T', '3-4y', '5-6y', '7-8y', '9-10y'],
      ['fabric', null, 'cotton jersey', 'brushed fleece', 'ripstop nylon', 'corduroy'],
      ['closure', null, 'elastic waist', 'adjustable waist', 'zip'],
      ['reinforcement', null, 'reinforced knees', 'double stitched', 'standard'],
      ['shoe_size', null, 'EU 26', 'EU 30', 'EU 34'],
    ],
    titles: 'apparel',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.76, 0.23, 0.01],
    cond: 'apparel',
    review: [4.2, 0.9, 290],
    themes: ['sizing', 'durability', 'fabric_quality', 'colour_accuracy', 'ease_of_use', 'value'],
  },
  babytoys: {
    price: [700, 12900],
    specs: [
      ['age', null, '0-6 months', '6-12 months', '12-18 months'],
      ['material', null, 'FSC beech', 'organic cotton', 'food-grade silicone', 'BPA-free plastic'],
      ['safety', null, 'EN71 certified', 'ASTM F963', 'no small parts'],
      ['feature', null, 'high-contrast', 'crinkle', 'rattle', 'teething surface'],
      ['washable', null, 'machine washable', 'wipe clean', 'dishwasher safe'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.9, 0.09, 0.01],
    cond: 'gently',
    review: [4.3, 0.8, 380],
    themes: ['safety', 'materials', 'engagement', 'cleaning', 'durability', 'value'],
  },
  kidstoys: {
    price: [900, 29900],
    specs: [
      ['age', null, '3+', '5+', '8+', '12+'],
      ['material', null, 'FSC beech', 'ABS plastic', 'die-cast metal', 'recycled plastic'],
      ['pieces', null, '45 pieces', '120 pieces', '500 pieces', '1000 pieces'],
      ['power', null, 'battery powered', 'manual', 'rechargeable'],
      ['safety', null, 'EN71 certified', 'ASTM F963', 'CE marked'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.86, 0.13, 0.01],
    cond: 'gently',
    review: [4.3, 0.8, 420],
    themes: ['engagement', 'durability', 'instructions', 'safety', 'packaging', 'value'],
  },
  kidsfurniture: {
    price: [4900, 99900],
    specs: [
      ['material', null, 'solid pine', 'birch plywood', 'lacquered MDF', 'powder-coated steel'],
      ['age_range', null, '18 months to 5 years', '3-10 years', '6+ years'],
      ['size', 'cm', '70x140', '90x190', '120x60'],
      ['weight_capacity', null, '50 kg', '80 kg', '100 kg'],
      ['finish', null, 'water-based lacquer', 'oiled', 'painted'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.88, 0.11, 0.01],
    cond: 'gently',
    review: [4.2, 0.9, 220],
    themes: ['assembly', 'stability', 'safety', 'build_quality', 'size_accuracy', 'value'],
  },
  kidssafety: {
    price: [700, 14900],
    specs: [
      ['width', 'cm', '75', '90', '110', '130'],
      ['mounting', null, 'pressure fit', 'screw fit', 'retractable mesh'],
      ['material', null, 'powder-coated steel', 'ABS plastic', 'bamboo'],
      ['pack_size', null, '2-pack', '4-pack', '12-pack'],
      ['certification', null, 'EN1930 certified', 'BS EN 12227', 'CPSC compliant'],
    ],
    titles: 'homegoods',
    models: ['{word}', '{word} {N}', '{A}{N}'],
    mix: [0.96, 0.04, 0.0],
    cond: 'nearNew',
    review: [4.2, 0.9, 310],
    themes: ['installation', 'safety', 'build_quality', 'fit_accuracy', 'value'],
  },
});

/** One profile for every L2 in the taxonomy. Verified by `assertCoverage`. */
export const L2_PROFILES: Record<string, L2Profile> = profiles;

// ---------------------------------------------------------------------------
// Review snippets
// ---------------------------------------------------------------------------

/**
 * `[positive, negative]` fragments per theme, authored as tuples so the table
 * stays one line per theme. Fragments are clause-shaped rather than whole
 * sentences: the seeder stitches two or three together into one review, which
 * is what makes a synthetic review about `stabilizers` read like one.
 */
type SnippetTuple = [positive: string[], negative: string[]];

const SNIPPET_SOURCE: Record<string, SnippetTuple> = {
  absorbency: [['soaks up water instantly', 'genuinely thirsty, not just thick'], ['pushes water around rather than absorbing it', 'still damp the next morning']],
  absorption: [['sinks in within a minute', 'no tacky film left behind'], ['sits on the skin for ages', 'never fully absorbs under makeup']],
  accuracy: [['measurements match my reference within a hair', 'repeatable readings run after run'], ['readings drift after a few minutes', 'off by enough to matter on precise work']],
  adjustment_mechanism: [['the dial changes weight in one smooth motion', 'locks positively every time'], ['the selector jams at the higher settings', 'plates rattle loose mid-set']],
  ankle_support: [['locks the ankle down on hard cuts', 'the collar padding holds without pinching'], ['almost no lateral support', 'rolled an ankle in these twice']],
  app_experience: [['the app is quick and stays logged in', 'setup and firmware updates just work'], ['the app is slow and loses devices constantly', 'half the features are buried behind an account']],
  application: [['goes on evenly in two coats', 'the brush loads the right amount'], ['streaks badly on the first coat', 'the brush is too wide for the nail bed']],
  arch_support: [['supports a high arch without a custom insole', 'no hot spots after a long day'], ['completely flat underfoot', 'my arches ached by the afternoon']],
  artwork: [['the illustration work is gorgeous', 'the art carries the whole table'], ['the art is muddy and hard to parse', 'iconography is inconsistent between cards']],
  assembly: [['assembled in twenty minutes with the included key', 'every hole lined up first time'], ['the pre-drilled holes did not line up', 'took two people and three hours']],
  authenticity: [['matches the retail pair detail for detail', 'stitching, tags and hardware all check out'], ['the font on the tag is wrong', 'a few details do not match the authentic version']],
  autofocus: [['locks onto eyes and stays there', 'tracks reliably even in low light'], ['hunts constantly in dim light', 'misses focus on anything moving']],
  backlight_bleed: [['corners are clean on a black screen', 'no glow in a dark room'], ['heavy bleed in the bottom corners', 'the clouding is obvious in dark scenes']],
  balance: [['balance sits right where I want it', 'feels neutral in the hand'], ['far too head heavy', 'the balance point is nothing like the spec']],
  bass_response: [['bass is tight and goes properly low', 'low end is present without bloating the mids'], ['bass is boomy and one-note', 'almost no extension below the midbass']],
  battery_life: [['easily gets through two days of real use', 'still at 40% after a long shift'], ['barely lasts half a day', 'the battery has clearly degraded already']],
  bezel_action: [['the bezel clicks with no back-play', 'perfectly aligned at 12'], ['the bezel is gritty and misaligned', 'back-play of nearly half a click']],
  binding: [['the binding is tight and square', 'opens without cracking the spine'], ['the glue failed within a month', 'pages started falling out after one read']],
  bokeh: [['background melts away beautifully', 'out-of-focus highlights stay round'], ['busy, nervous bokeh', 'onion rings in every highlight']],
  bounce: [['sits still even at race pace', 'no bounce with a full bottle'], ['bounces around constantly', 'rode up every kilometre']],
  bracelet_quality: [['solid end links with no rattle', 'the clasp is milled, not stamped'], ['hollow end links and a stamped clasp', 'the bracelet rattles on the wrist']],
  break_in: [['broke in within a week', 'comfortable from the first wear'], ['took two months of blisters to break in', 'still stiff after twenty wears']],
  breathability: [['stays cool on hot days', 'vents well without letting rain in'], ['gets clammy within an hour', 'traps heat badly']],
  brightness: [['easily visible in direct sun', 'bright enough for outdoor monitoring'], ['washes out completely outdoors', 'nowhere near the rated brightness']],
  build_quality: [['feels dense and properly put together', 'no flex or creak anywhere'], ['panel gaps and creaks straight out of the box', 'feels hollow and cheap for the price']],
  button_feel: [['crisp, tactile clicks', 'triggers have no pre-travel'], ['mushy buttons with inconsistent travel', 'one shoulder button already sticks']],
  cable_management: [['routing channels hide everything cleanly', 'the tray swallows a full set of cables'], ['nowhere to route cables at all', 'the clips snapped off immediately']],
  capacity: [['holds far more than the numbers suggest', 'fits a full week without cramming'], ['the stated capacity is optimistic', 'much smaller inside than it looks']],
  case_quality: [['the case is rigid and everything has a home', 'latches stay shut in a van'], ['the case cracked on the first drop', 'nothing sits properly in its cutout']],
  certification: [['papers and certificate are present and match', 'independently certified with the number on file'], ['no certificate despite the listing implying one', 'the paperwork does not match the piece']],
  charging_speed: [['tops a phone up in under an hour', 'hits the rated wattage without throttling'], ['charges far slower than advertised', 'drops to trickle speed once it warms up']],
  chip_resistance: [['survived a year of dishwasher cycles', 'no chips despite daily use'], ['chipped on the second wash', 'the rims are already nicked']],
  chromatic_aberration: [['almost no fringing wide open', 'clean edges on high-contrast branches'], ['purple fringing on every backlit edge', 'needs correcting in post every time']],
  clarity: [['text is sharp edge to edge', 'no god rays in bright scenes'], ['blurry outside a small sweet spot', 'noticeable glare and smearing']],
  clasp_quality: [['the clasp is secure and easy one-handed', 'has not come undone once'], ['the clasp springs open unprompted', 'lost it because the clasp failed']],
  cleaning: [['wipes clean in seconds', 'dishwasher safe with no discolouring'], ['impossible to clean the crevices', 'stains within the first week']],
  closeness: [['two passes give a genuinely close shave', 'gets under the jawline cleanly'], ['leaves stubble no matter the angle', 'needed three passes and still not close']],
  colour_accuracy: [['the colour matches the listing photos exactly', 'accurate out of the box, no calibration needed'], ['much more orange than pictured', 'the photos are nothing like the real colour']],
  colour_cast: [['neutral even at ten stops', 'no cast to correct afterwards'], ['strong magenta cast at high densities', 'every frame needs white balance rescuing']],
  comfort: [['comfortable for a full day', 'forget it is there after ten minutes'], ['uncomfortable after an hour', 'pressure points in all the wrong places']],
  compatibility: [['dropped straight into my existing setup', 'worked with every device I tried'], ['would not play with my board at all', 'the compatibility list is misleading']],
  completeness: [['complete with box, inserts and manual', 'everything the listing promised was in the package'], ['arrived missing the inner tray', 'described as complete but the manual was absent']],
  component_quality: [['thick board and properly punched tokens', 'the components feel premium'], ['thin cardboard that warps immediately', 'the pieces feel like an afterthought']],
  condition_accuracy: [['condition was described honestly, flaws and all', 'better than the grading suggested'], ['the flaws were not mentioned in the listing', 'graded far more generously than it deserves']],
  connectivity: [['every input worked first time', 'pairs instantly and holds the connection'], ['drops the connection constantly', 'two of the ports do nothing']],
  consistency: [['results are repeatable roll to roll', 'the same settings give the same output every time'], ['wildly inconsistent batch to batch', 'one roll was fine, the next was unusable']],
  control: [['placement is precise even on the run', 'exactly the control I wanted'], ['no feel for where the ball is going', 'too stiff to control anything']],
  coverage: [['evens out redness in one layer', 'buildable without going cakey'], ['far sheerer than described', 'settles into every line by lunchtime']],
  cushioning: [['plush without feeling mushy', 'protective over long distances'], ['the foam packed out in a month', 'harsh and unforgiving underfoot']],
  delivery: [['arrived early and fully wrapped', 'the carrier brought it inside and unpacked it'], ['left on the driveway in the rain', 'took six weeks and two failed deliveries']],
  dial_quality: [['the dial texture is stunning in person', 'printing is crisp under a loupe'], ['the printing is blurry at the edges', 'the dial has a mark under the crystal']],
  digestion: [['settled a sensitive stomach within a week', 'firmer stools almost immediately'], ['caused an upset stomach from day one', 'had to switch back after a week']],
  dimming: [['dims smoothly to a very low level', 'no flicker at any level'], ['buzzes audibly when dimmed', 'will not go below half brightness']],
  distance: [['picked up ten yards over my old one', 'carries noticeably further'], ['no distance gain at all', 'shorter than the club it replaced']],
  documentation: [['the documentation is thorough and accurate', 'schematics and pinouts are all published'], ['documentation is a single translated page', 'the wiring diagram is simply wrong']],
  drag_smoothness: [['the drag is buttery from the first turn', 'no start-up inertia on light line'], ['the drag stutters under load', 'jerky enough to pop light tippet']],
  drainage: [['drains properly and never waterlogs', 'the reservoir keeps things even'], ['no drainage hole despite the description', 'water pools and the roots rotted']],
  drape: [['hangs beautifully without clinging', 'the drape is exactly as pictured'], ['hangs stiffly and sticks out', 'clings in all the wrong places']],
  drawer_action: [['soft-close runners on every drawer', 'drawers glide even when full'], ['the drawers bind halfway out', 'the runners came loose in a fortnight']],
  drop_protection: [['survived a waist-high drop onto tile', 'the raised lip saved the screen'], ['cracked the phone on the first drop', 'the corners offer no real protection']],
  durability: [['still looks new after a year of hard use', 'no visible wear after daily use'], ['fell apart within two months', 'the stitching gave out almost immediately']],
  dust: [['almost no dust when pouring', 'nothing settles on nearby surfaces'], ['creates a dust cloud every time', 'fine dust coats the whole room']],
  ease_of_use: [['intuitive from the first minute', 'no manual needed'], ['needlessly fiddly to operate', 'took three attempts to work out the sequence']],
  edge_hold: [['holds an edge confidently on hardpack', 'grips even on scraped ice'], ['washes out on anything firm', 'no edge hold whatsoever']],
  edge_retention: [['still slices paper after months', 'holds an edge through a full prep session'], ['dulled after two weeks', 'needs stropping every single use']],
  edging: [['stands on tiny edges confidently', 'the toe box transmits everything'], ['the toe rolls on small edges', 'too soft for anything technical']],
  effectiveness: [['visible difference within a fortnight', 'does exactly what it claims'], ['no noticeable difference after two months', 'did nothing the cheaper option did not']],
  embroidery_quality: [['dense, clean stitching on the logo', 'the embroidery has not pulled at all'], ['loose threads around the logo', 'the embroidery puckered after one wash']],
  engagement: [['held attention far longer than expected', 'went back to it every day'], ['ignored after five minutes', 'lost interest almost immediately']],
  ergonomics: [['the grip falls naturally into the hand', 'controls are exactly where the fingers land'], ['awkward to hold for any length of time', 'the controls are in all the wrong places']],
  escape_resistance: [['no chance of backing out of it', 'held a determined puller securely'], ['slipped out of it on the first walk', 'the buckle released under load']],
  fabric_quality: [['the fabric has real weight and body', 'feels far more expensive than it was'], ['the fabric is thin and see-through', 'pilled after two wears']],
  fade_quality: [['fading beautifully at the whiskers already', 'the indigo is deep and fades honestly'], ['faded flat and grey within a month', 'no character to the fades at all']],
  feel: [['feedback off the face is soft and solid', 'you feel exactly where it struck'], ['feels dead and clicky', 'harsh vibration on anything off-centre']],
  filter_cost: [['filters are cheap and easy to find', 'washable filter, no running cost'], ['replacement filters cost a fortune', 'proprietary filters with no third-party option']],
  finish_quality: [['the glaze is even and flawless', 'the finish is consistent across the set'], ['visible glaze pooling and pinholes', 'the finish was scuffed out of the box']],
  finishing: [['the finishing holds up under a loupe', 'bevels are crisp and evenly polished'], ['tool marks visible on the case', 'the polishing is uneven in places']],
  firmness: [['exactly the firmness described', 'supportive without being hard'], ['much softer than the firmness rating', 'sagged in the middle within months']],
  fit_accuracy: [['fits exactly as specified with no play', 'cutouts line up perfectly'], ['the cutouts are noticeably misaligned', 'loose enough to shift around']],
  fit_and_finish: [['the fit and finish is flawless', 'every joint is tight and clean'], ['sloppy finishing at the joints', 'glue squeeze-out left everywhere']],
  fitment: [['bolted straight on with no modification', 'fitment on my car was perfect'], ['needed drilling to fit despite the listing', 'does not fit the vehicle it lists']],
  flare_control: [['holds contrast shooting into the sun', 'no veiling flare at all'], ['flares badly with any light source in frame', 'contrast collapses when backlit']],
  flex: [['the flex rating is bang on', 'stiff enough to drive, forgiving in chop'], ['far softer than the rating suggests', 'noodly at any real speed']],
  flight_stability: [['rock steady in gusty wind', 'holds position without drifting'], ['drifts constantly even in calm air', 'twitchy and hard to keep level']],
  flow_rate: [['strong flow with no surging', 'turns the tank over properly'], ['flow is far below the rated figure', 'clogs and slows within a week']],
  fold_ease: [['folds one-handed while holding a baby', 'collapses small enough for the boot'], ['takes two hands and a knee to fold', 'the fold latch jams constantly']],
  forgiveness: [['off-centre strikes still fly straight', 'very forgiving on mishits'], ['punishes anything off the sweet spot', 'far less forgiving than advertised']],
  framing: [['the frame is square and well finished', 'came ready to hang'], ['the frame arrived with a cracked corner', 'the mount was cut off-centre']],
  freshness: [['fresh dated with plenty of shelf life', 'cold-stored and perfectly consistent'], ['arrived months past the date', 'clearly stored warm — heavy fog']],
  ghosting: [['no show-through even with wet ink', 'handles fountain pen without bleeding'], ['ghosts badly on the reverse', 'feathering with any wet nib']],
  grading: [['the grade is conservative and fair', 'slab and label match the census'], ['over-graded by at least a point', 'the slab has been cracked and resealed']],
  grain: [['fine grain with pleasing texture', 'holds shadow detail without mush'], ['grain is coarse and blotchy', 'muddy shadows and heavy base fog']],
  grind_consistency: [['very even grind with almost no fines', 'espresso and pour-over both dial in easily'], ['produces a lot of boulders and dust', 'inconsistent enough to ruin the shot']],
  grip: [['grippy even with sweaty hands', 'stays put on any surface'], ['slips constantly once damp', 'the texture wore smooth in weeks']],
  hair_damage: [['no split ends after months of use', 'gentler than my old one at the same heat'], ['fried the ends within a few uses', 'runs far hotter than the display claims']],
  handle_comfort: [['the handle fills the hand nicely', 'no hot spots during long sessions'], ['the handle digs into the palm', 'gets uncomfortably hot on the hob']],
  hardware_quality: [['solid metal hardware throughout', 'the zips run smoothly and feel robust'], ['the zip pull snapped in a week', 'painted plastic hardware pretending to be metal']],
  heat: [['stays cool even under sustained load', 'barely warm after hours of use'], ['gets uncomfortably hot to hold', 'throttles once it heats up']],
  heat_distribution: [['heats evenly edge to edge', 'no hot spot over the burner'], ['a fierce hot spot in the centre', 'the edges never get up to temperature']],
  heat_up_time: [['at temperature in under thirty seconds', 'ready before I have parted my hair'], ['takes minutes to get hot', 'never reaches the temperature it displays']],
  hold: [['holds all day without stiffening', 'restylable hours later'], ['drops out by midday', 'crunchy and flaky within an hour']],
  image_quality: [['files hold up beautifully at high ISO', 'tonality and colour straight out of camera are lovely'], ['noisy above base ISO', 'colours need heavy work in post']],
  imaging: [['the stereo image is precise and wide', 'instruments sit in clearly defined space'], ['the image collapses to the centre', 'everything smears together']],
  ingredient_quality: [['named meat first, no filler', 'a genuinely clean ingredient list'], ['the first ingredient is a cheap filler', 'the formula changed and the quality dropped']],
  ink_flow: [['flows consistently from the first stroke', 'no hard starts even after a week capped'], ['hard starts every session', 'skips constantly on fast strokes']],
  installation: [['installed in under an hour with basic tools', 'the template made it foolproof'], ['the instructions omit a critical step', 'needed a professional to finish the install']],
  instructions: [['clear, well illustrated instructions', 'every step is numbered and photographed'], ['the instructions are a badly translated page', 'the diagrams do not match the parts']],
  irritation: [['no stinging even on sensitive skin', 'no reaction after weeks of daily use'], ['stung on application and left redness', 'brought on a reaction within days']],
  isolation: [['blocks out the train completely', 'seals well without pressure'], ['leaks sound in both directions', 'almost no isolation at all']],
  jog_feel: [['the jogs are responsive with just the right weight', 'nudging is precise'], ['the jogs feel loose and imprecise', 'noticeable latency on scratch']],
  key_action: [['the action is weighted and expressive', 'keys respond evenly across the range'], ['the keys feel spongy and uneven', 'velocity response is impossible to control']],
  knurling: [['the knurling grips without shredding', 'aggressive enough for heavy pulls'], ['the knurling is almost smooth', 'tore my hands up in one session']],
  latency: [['latency is low enough to monitor live', 'no perceptible delay at small buffers'], ['unusable latency even at high buffer sizes', 'crackles the moment the buffer drops']],
  lather_quality: [['whips up a rich lather in seconds', 'the lather stays slick through three passes'], ['the lather collapses immediately', 'takes forever to build anything usable']],
  lay_flat: [['lies completely flat at any page', 'stays open without holding it'], ['snaps shut unless weighted down', 'will not lie flat until well past the middle']],
  leaking: [['no leaks even upside down in a bag', 'the seal holds under pressure'], ['leaks around the collar every feed', 'dripped all over the bag']],
  leather_quality: [['the leather is thick and already developing a patina', 'full-grain and properly finished'], ['thin, heavily corrected leather', 'the finish cracked within months']],
  legibility: [['readable at a glance in any light', 'high contrast hands and markers'], ['the hands vanish against the dial', 'the date window is far too small']],
  light_quality: [['the light is warm and genuinely flattering', 'no glare and an even spread across the room'], ['the light is cold and clinical', 'casts harsh shadows and a visible hotspot']],
  light_seals: [['the seals have been replaced and are perfect', 'no leaks across a full test roll'], ['the seals have turned to sticky foam', 'light leaks down the edge of every frame']],
  lining: [['the lining is smooth and well stitched', 'breathes better than a synthetic lining'], ['the lining tore at the armhole', 'cheap polyester lining that clings']],
  longevity: [['lasts a full working day on skin', 'still detectable the next morning'], ['gone within two hours', 'barely lasts past the drydown']],
  lume: [['the lume is blindingly bright and lasts all night', 'evenly applied across every marker'], ['the lume fades within minutes', 'the hands and markers glow unevenly']],
  manoeuvrability: [['turns on a coin one-handed', 'handles kerbs and gravel easily'], ['the front wheels judder on any rough surface', 'impossible to steer one-handed']],
  materials: [['the materials feel genuinely premium', 'solid wood and metal, no plastic'], ['cheap plastic where metal was implied', 'the materials feel nothing like the photos']],
  mechanical_condition: [['starts on the button and pulls cleanly', 'no leaks, no smoke, no odd noises'], ['a top-end rattle that was not disclosed', 'needed a carb rebuild the week it arrived']],
  metal_quality: [['solid, properly hallmarked metal', 'heavier than expected in a good way'], ['the plating wore through in weeks', 'much lighter and thinner than it looks']],
  mileage: [['low mileage and it shows everywhere', 'mileage matches the service book'], ['the mileage does not match the paperwork', 'far more wear than the mileage suggests']],
  moisturising: [['keeps dry skin comfortable all day', 'cured winter flaking in a week'], ['not remotely rich enough for dry skin', 'leaves a greasy film without hydrating']],
  motor_noise: [['the motors are barely audible', 'raises and lowers smoothly and quietly'], ['the motor whines loudly on every adjustment', 'wakes the house when it moves']],
  nib_smoothness: [['glassy smooth with a hint of feedback', 'no scratchiness at any angle'], ['scratchy out of the box', 'catches on the upstroke constantly']],
  noise: [['quiet enough to run at night', 'noticeably quieter than what it replaced'], ['far louder than expected', 'a high-pitched whine you cannot unhear']],
  noise_floor: [['dead silent at high gain', 'no hiss with sensitive headphones'], ['audible hiss even at low volume', 'picks up interference from everything nearby']],
  odour: [['no smell at all out of the packaging', 'aired out within a day'], ['a strong chemical smell that never faded', 'smelled of smoke and had to be cleaned']],
  organisation: [['pockets for everything, all where you expect', 'the layout makes sense in daily use'], ['one big void with no structure', 'the pockets are too shallow to use']],
  packability: [['packs down smaller than the stated size', 'disappears into a daypack'], ['bulky even in the compression sack', 'never fits back in its own bag']],
  packaging: [['packed carefully with plenty of protection', 'arrived in perfect condition, well boxed'], ['thrown in a bag with no padding', 'the box was crushed and the contents damaged']],
  padding: [['the padding absorbs impact properly', 'dense foam that has not packed out'], ['the padding compressed after a few sessions', 'far too thin for heavy bag work']],
  paint_quality: [['the paint application is crisp and clean', 'no slop on any of the fine details'], ['sloppy paint over the panel lines', 'visible overspray on the face']],
  palatability: [['eaten enthusiastically from the first bowl', 'even the fussy one finished it'], ['refused it outright', 'had to mix it with something else to get it eaten']],
  paper_quality: [['the paper takes wet ink without feathering', 'smooth and substantial under the nib'], ['thin paper that bleeds through', 'the surface is rough and catches the nib']],
  performance: [['holds frame rates well above what I expected', 'handles everything I have thrown at it'], ['struggles well below the claimed performance', 'stutters under any real load']],
  pigment_quality: [['highly pigmented and genuinely single-pigment', 'mixes cleanly without going muddy'], ['chalky and weak in tint', 'labelled single-pigment but clearly a hue']],
  pile_quality: [['dense pile that springs back underfoot', 'the weave is tight and even'], ['the pile has already flattened in the walkway', 'thin and sparse compared to the photos']],
  plant_health: [['arrived healthy with new growth already', 'well rooted and no pests'], ['arrived with yellowing leaves', 'root rot was already underway']],
  playability: [['the action was set up perfectly out of the case', 'plays effortlessly up the neck'], ['buzzing frets that need a setup', 'the action was unplayably high']],
  playing_surface: [['the bounce is even across the whole table', 'true roll from any angle'], ['dead spots across the surface', 'the surface warped within a season']],
  pocket_shape: [['the pocket formed exactly where I wanted it', 'holds its shape after break-in'], ['the pocket collapsed after a month', 'never formed a usable pocket']],
  pockets: [['deep pockets that actually hold tools', 'reinforced at every stress point'], ['the pockets are far too shallow', 'the pocket bag tore on the first load']],
  pop: [['plenty of pop and it has lasted', 'still snappy after weeks of use'], ['went soft after a couple of sessions', 'no pop from the first day']],
  portability: [['light enough to carry all day', 'packs down and travels easily'], ['far too heavy to carry anywhere', 'no practical way to transport it']],
  power: [['plenty of power with room to spare', 'noticeably more powerful than the last one'], ['underpowered for the job', 'nowhere near the rated output']],
  print_quality: [['the print is sharp with deep, even ink', 'registration is perfect across the sheet'], ['the print is soft and the blacks are grey', 'visible banding across the flat areas']],
  privacy: [['local control with no cloud account required', 'works entirely on the local network'], ['forces a cloud account for basic features', 'sends far more telemetry than it needs to']],
  protection: [['the armour stayed put in a slide', 'certified protection where it matters'], ['the armour shifts out of position constantly', 'padding is token at best']],
  provenance: [['full provenance chain documented', 'came with the original bill of sale'], ['no provenance offered at all', 'the provenance story does not hold up']],
  pusher_feel: [['the pushers actuate crisply with no mush', 'reset is instant and positive'], ['the pushers are spongy and vague', 'the reset sticks half the time']],
  range: [['holds signal to the edge of sight', 'range exceeds the spec in open ground'], ['signal drops out well short of the claim', 'loses connection behind a single wall']],
  recycle_time: [['recycles fast enough to shoot bursts', 'consistent recycle at full power'], ['recycle time doubles once it warms up', 'far slower at full power than specified']],
  region_compatibility: [['region-free and worked on my console', 'the region matched the listing exactly'], ['the wrong region for my console', 'region lock was not mentioned in the listing']],
  reliability: [['has not missed a beat in a year', 'utterly dependable day to day'], ['needs a reset every few days', 'failed twice in the first month']],
  replayability: [['every playthrough goes somewhere different', 'still finding new strategies after twenty games'], ['solved after three plays', 'the variability is cosmetic only']],
  residue: [['rinses clean with no build-up', 'leaves nothing behind on the scalp'], ['leaves a waxy residue that builds up', 'needed a clarifying wash to remove it']],
  resoleability: [['the welt means it will resole indefinitely', 'already resoled once with no trouble'], ['cemented construction so it cannot be resoled', 'the cobbler refused to touch the sole']],
  restoration_quality: [['sympathetically restored with correct materials', 'the restoration is invisible and reversible'], ['a heavy-handed restoration that killed the patina', 'modern parts passed off as original']],
  ride_comfort: [['soaks up rough surfaces without feeling vague', 'comfortable over long days in the saddle'], ['harsh over anything but smooth tarmac', 'numbing vibration through the bars']],
  rise_accuracy: [['the rise measures exactly as listed', 'sits where a high rise should'], ['the rise is a good two inches lower than stated', 'sits far lower than the photos suggest']],
  road_noise: [['quiet at motorway speed', 'noticeably quieter than the tyres they replaced'], ['a constant drone from 50 mph up', 'far noisier than the rating implies']],
  rules_clarity: [['the rulebook is clear with good examples', 'taught in ten minutes from the summary'], ['the rulebook is ambiguous on key points', 'spent the first game looking up rules']],
  safety: [['all the certifications check out', 'no sharp edges or small parts anywhere'], ['a small part broke off immediately', 'no safety markings despite the claims']],
  scent: [['the scent is beautifully balanced', 'subtle and never cloying'], ['smells synthetic and harsh', 'the fragrance is overpowering']],
  screen_quality: [['the panel is bright with excellent contrast', 'colours look accurate straight away'], ['the panel is dim and washed out', 'visible backlight unevenness']],
  seal_quality: [['the seal holds even upside down', 'keeps food fresh for a week'], ['the gasket leaks after a few washes', 'the lid stopped sealing within a month']],
  seasoning: [['arrived pre-seasoned and slick', 'the seasoning built up fast and evenly'], ['the factory seasoning flaked off immediately', 'rusted before I could season it']],
  sensitivity: [['telegraphs the lightest taps', 'you feel everything through the blank'], ['too dull to feel a take', 'no feedback through the handle at all']],
  sensor_accuracy: [['tracks flawlessly at any speed', 'no spin-outs or smoothing'], ['jitters at low DPI', 'noticeable acceleration I could not disable']],
  service_history: [['fully documented service history', 'recently serviced with the receipt included'], ['no service history at all', 'the claimed service cannot be verified']],
  setup_ease: [['up and running in five minutes', 'paired on the first attempt'], ['setup took an evening and two support chats', 'the pairing process failed repeatedly']],
  setup_quality: [['arrived properly set up and intonated', 'the factory setup needed nothing'], ['arrived badly out of intonation', 'needed a full setup before it was playable']],
  shade_range: [['the shade range covers real skin tones', 'found an exact match on the first try'], ['the deeper shades are an afterthought', 'every shade is far too warm']],
  shape_retention: [['holds its shape through washes', 'the crown still sits properly'], ['lost its shape after one wash', 'the brim went floppy immediately']],
  sharpness: [['bitingly sharp across the frame wide open', 'corners sharpen up by f/4'], ['soft in the corners even stopped down', 'never really sharp at any aperture']],
  sharpness_out_of_box: [['shaving sharp out of the box', 'sliced tomatoes without pressure on day one'], ['arrived blunt and needed stoning', 'the factory edge was uneven']],
  shedding: [['no shedding after weeks of use', 'not a single loose fibre'], ['sheds constantly onto everything', 'left bristles all over the face']],
  sheerness: [['opaque even in the light colour', 'no need for anything underneath'], ['completely see-through in daylight', 'far sheerer than the photos suggest']],
  shrinkage: [['no shrinkage after repeated hot washes', 'true to size after the first wash'], ['shrank a full size in one wash', 'shrank lengthwise and became a crop top']],
  shutter_accuracy: [['speeds tested accurate across the range', 'the slow speeds run true'], ['the slow speeds hang badly', 'a full stop slow at the top end']],
  shutter_count: [['very low shutter count for the age', 'the count matches what was advertised'], ['the shutter count is far higher than stated', 'well past the rated shutter life']],
  sillage: [['leaves a pleasant trail without shouting', 'people notice from a metre away'], ['no projection at all', 'fills the whole room within minutes']],
  size_accuracy: [['dimensions match the listing to the centimetre', 'exactly the size I measured for'], ['noticeably smaller than the listed dimensions', 'the measurements in the listing are wrong']],
  sizing: [['true to size, no need to size up', 'the size chart was accurate'], ['runs a full size small', 'the sizing is wildly inconsistent between colours']],
  smell: [['pleasant, mild smell', 'no chemical odour at all'], ['a harsh chemical smell that lingers', 'had to use it with the window open']],
  softness: [['soft from the first wash and softening further', 'genuinely comfortable against skin'], ['scratchy even after several washes', 'stiff and rough out of the packet']],
  software: [['the configuration software is clean and stores profiles onboard', 'no account needed and it just works'], ['the software is bloated and crashes', 'settings do not persist between reboots']],
  sound_quality: [['clean, detailed output at volume', 'far better than the factory system'], ['distorts badly past half volume', 'muddy and thin at any level']],
  sound_signature: [['balanced tuning with a natural midrange', 'detailed without being fatiguing'], ['harsh, sibilant treble', 'recessed mids make voices sound distant']],
  soundstage: [['wide, open stage with real depth', 'instruments have space to breathe'], ['the stage is flat and closed in', 'everything sounds like it is inside your head']],
  squat_proof: [['completely opaque through deep squats', 'no show-through under any light'], ['see-through the moment you bend', 'the seams gape under load']],
  stability: [['rock solid with no wobble', 'stays put even when loaded to the limit'], ['wobbles alarmingly when extended', 'tips forward under normal use']],
  stabilizers: [['the stabilisers came lubed and rattle-free', 'no ticking on the spacebar at all'], ['the stabilisers rattle badly out of the box', 'had to tune the spacebar before it was usable']],
  stand_quality: [['the stand is solid with full height adjustment', 'no wobble when typing'], ['the stand wobbles constantly', 'tilt only, no height adjustment at all']],
  stick_drift: [['hall effect sticks and no drift after months', 'still perfectly centred'], ['developed stick drift within weeks', 'the left stick drifted out of the box']],
  stitching: [['clean, even stitching throughout', 'bar-tacked at every stress point'], ['crooked stitching and loose threads', 'a seam gave way on the first wear']],
  stone_quality: [['the stone is lively with no visible inclusions', 'cut and colour are better than the grade suggests'], ['visible inclusions to the naked eye', 'the stone is dull and poorly cut']],
  storage_capacity: [['the basket swallows a full shop', 'storage is genuinely usable'], ['the basket is tiny and hard to reach', 'nowhere to put anything']],
  strap_quality: [['the strap is supple and well finished', 'quick-release pins make swaps trivial'], ['the strap is stiff cardboard-grade leather', 'the strap cracked within weeks']],
  stretch_recovery: [['holds its shape all day with no bagging', 'snaps back after every wash'], ['bags out at the knees within an hour', 'lost all elasticity after a few washes']],
  suction_power: [['pulls embedded grit out of carpet', 'strong suction that holds up on the lower setting'], ['suction fades as soon as the bin fills', 'nowhere near strong enough for pet hair']],
  support: [['supportive without any digging', 'holds up all day with no readjusting'], ['no real support at all', 'the underwire digs in within an hour']],
  surface_finish: [['the finish is even and feels beautiful', 'the grain came through perfectly'], ['visible sanding marks under the finish', 'the finish marks if you look at it wrong']],
  sweat_wicking: [['wicks fast and dries between sessions', 'never feels clammy mid-workout'], ['holds sweat and stays soaked', 'smells within one session']],
  switch_feel: [['the tactile bump is crisp and well defined', 'smooth travel with no scratchiness'], ['scratchy and inconsistent switch to switch', 'the bump is so faint it feels linear']],
  tailoring_quality: [['the canvassing gives it real shape', 'the shoulder is beautifully constructed'], ['the shoulder collapses and the chest is flat', 'clearly fused despite the description']],
  tarnishing: [['no tarnish after months of daily wear', 'still bright with no maintenance'], ['tarnished within a fortnight', 'turned my skin green almost immediately']],
  temperature_stability: [['holds temperature shot after shot', 'recovers in seconds between pulls'], ['temperature swings wildly between shots', 'never holds the set temperature']],
  texture: [['the texture is light and spreads easily', 'silky without being slippery'], ['thick and tacky on the skin', 'pills the moment anything goes over it']],
  thermals: [['runs cool and quiet under sustained load', 'temperatures stay well within spec'], ['thermal throttles within ten minutes', 'runs far hotter than comparable units']],
  thickness: [['slim enough to slide under a cuff', 'the case is thinner than the numbers suggest'], ['far thicker than the specification', 'too thick to wear under anything fitted']],
  tone: [['warm, complex tone with real sustain', 'sounds better the more it is played'], ['thin and brittle sounding', 'no sustain and a boxy midrange']],
  torque: [['plenty of torque for long screws in hardwood', 'the clutch settings are usable and accurate'], ['stalls in anything dense', 'nowhere near the quoted torque']],
  touch: [['the ball comes off the foot cleanly', 'great feel on the first touch'], ['no feel through the upper at all', 'the ball pings off unpredictably']],
  tracking: [['almost nothing gets tracked out of the box', 'the mat catches what little escapes'], ['tracked across the entire house', 'found granules in every room']],
  tracking_accuracy: [['step and heart rate match my chest strap closely', 'GPS traces are clean even under tree cover'], ['heart rate readings are wildly wrong during intervals', 'the GPS track wanders off the road']],
  traction: [['grips hard on dusty courts', 'bites on wet grass without clogging'], ['slides on anything dusty', 'the studs clog instantly in mud']],
  transfer_speed: [['sustains close to the rated speed on big files', 'copied a full project in minutes'], ['speeds collapse after the cache fills', 'nowhere near the advertised throughput']],
  upholstery_quality: [['the upholstery is tight with clean seams', 'the fabric has worn beautifully'], ['the upholstery is already pilling', 'puckered seams along the whole front']],
  value: [['exceptional for what it cost', 'outperforms things twice the price'], ['nowhere near worth the asking price', 'the cheaper option does the same job']],
  ventilation: [['airflow is excellent at speed', 'the vents make a real difference on hot days'], ['no meaningful airflow at all', 'the vents do nothing below motorway speed']],
  video_quality: [['footage is sharp and well stabilised', 'the colour profile grades easily'], ['heavy compression artefacts in detailed scenes', 'the stabilisation warps the frame edges']],
  warmth: [['warm well below the rated temperature', 'genuinely warm without the bulk'], ['nowhere near warm enough for the rating', 'cold spots wherever the fill has shifted']],
  wear_time: [['still looks fresh at the end of a long day', 'survived a full shift without touch-ups'], ['chipped within a day', 'faded away before lunch']],
  weather_resistance: [['shrugged off a full day of rain', 'no wetting out at the shoulders'], ['wetted through within an hour', 'the seams leaked in the first storm']],
  weight: [['noticeably lighter than it looks', 'light enough to carry all day'], ['much heavier than the listed weight', 'too heavy to use comfortably one-handed']],
  wet_grip: [['confident braking in standing water', 'no aquaplaning even in heavy rain'], ['loses grip alarmingly in the wet', 'noticeably worse in rain than the rating suggests']],
  workflow: [['the workflow is immediate and hands-on', 'everything has a dedicated control'], ['everything is buried in menus', 'the workflow fights you at every step']],
  wrist_support: [['the wrist is well supported on heavy bags', 'no wrist soreness after long sessions'], ['almost no wrist support', 'tweaked a wrist in the first session']],
};

/** Used when a theme has no authored snippets — never left to fail silently. */
export const GENERIC_SNIPPETS: ReviewSnippetSet = {
  positive: [
    'exactly what I hoped for',
    'has held up better than expected',
    'would buy again without hesitating',
    'does the job well and looks good doing it',
  ],
  negative: [
    'not what the listing led me to expect',
    'disappointing for what it cost',
    'started showing problems almost immediately',
    'returned it and bought something else',
  ],
};

export const REVIEW_SNIPPETS: Record<string, ReviewSnippetSet> = Object.fromEntries(
  Object.entries(SNIPPET_SOURCE).map(([theme, [positive, negative]]) => [
    theme,
    { positive, negative },
  ]),
);

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** Throws rather than returning a default: a silent fallback would quietly give a whole L2 the wrong prices. */
export function profileFor(l2Id: string): L2Profile {
  const profile = profiles[l2Id];
  if (!profile) throw new Error(`No L2 profile for category: ${l2Id}`);
  return profile;
}

export function brandsFor(l1Id: string): string[] {
  const brands = BRANDS_BY_L1[l1Id];
  if (!brands) throw new Error(`No brands for L1 category: ${l1Id}`);
  return brands;
}

export function snippetsFor(theme: string, polarity: ReviewPolarity): string[] {
  const set = REVIEW_SNIPPETS[theme];
  if (!set) return GENERIC_SNIPPETS[polarity];
  return set[polarity];
}

/**
 * Structural check over the whole corpus, run by the seeder before it writes a
 * single document. A missing profile would silently starve an entire L2 of
 * listings, which is far harder to notice downstream than a startup throw.
 */
export function assertCoverage(): void {
  const problems: string[] = [];

  const missing = L2_TOPICS.filter((node) => !profiles[node.id]).map((node) => node.id);
  if (missing.length > 0) {
    problems.push(`missing L2 profiles (${missing.length}): ${missing.join(', ')}`);
  }

  const known = new Set(L2_TOPICS.map((node) => node.id));
  const extra = Object.keys(profiles).filter((id) => !known.has(id));
  if (extra.length > 0) problems.push(`profiles for unknown L2 ids: ${extra.join(', ')}`);

  const missingBrands = [...new Set(L2_TOPICS.map((node) => node.l1))].filter(
    (l1) => !BRANDS_BY_L1[l1],
  );
  if (missingBrands.length > 0) problems.push(`missing brand lists: ${missingBrands.join(', ')}`);

  const missingThemes = new Set<string>();
  for (const profile of Object.values(profiles)) {
    const [min, max] = profile.priceRange;
    if (!(min > 0 && max > min)) {
      problems.push(`${profile.id}: implausible price range [${min}, ${max}]`);
    }
    const mixSum =
      profile.sourceTypeMix.new +
      profile.sourceTypeMix.secondhand +
      profile.sourceTypeMix.auction;
    if (Math.abs(mixSum - 1) > 1e-6) {
      problems.push(`${profile.id}: sourceTypeMix sums to ${mixSum.toFixed(4)}`);
    }
    const condSum = Object.values(profile.conditionMix).reduce((a, b) => a + b, 0);
    if (Math.abs(condSum - 1) > 1e-6) {
      problems.push(`${profile.id}: conditionMix sums to ${condSum.toFixed(4)}`);
    }
    if (profile.specKeys.length < 3) problems.push(`${profile.id}: fewer than 3 spec keys`);
    if (profile.themes.length < 4) problems.push(`${profile.id}: fewer than 4 themes`);
    for (const theme of profile.themes) {
      if (!REVIEW_SNIPPETS[theme]) missingThemes.add(theme);
    }
  }
  if (missingThemes.size > 0) {
    problems.push(`themes without review snippets: ${[...missingThemes].sort().join(', ')}`);
  }

  if (problems.length > 0) {
    throw new Error(`Corpus coverage failed:\n  ${problems.join('\n  ')}`);
  }
}
