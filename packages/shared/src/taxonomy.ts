/**
 * The three-level topic taxonomy.
 *
 *   L1  —   18 topics. Onboarding tiles and the exploration diversity unit.
 *   L2  —  180 topics. Quad grouping in Window mode and the diversity guardrail.
 *   L3  — 1440 topics. Retrieval filter and interest-set granularity.
 *
 * Authored as a compact literal and expanded into `CategoryNode`s at module
 * load. L3 ids prefer the bare slug and fall back to an `l2-slug` form when the
 * bare slug is already taken, which keeps well-known leaves such as
 * `mechanical-keyboards` addressable by their natural name.
 */

export interface CategoryNode {
  id: string;
  level: 1 | 2 | 3;
  parent: string | null;
  l1: string;
  displayName: string;
  /** L1 only. */
  tileOrder: number | null;
}

/** [l2Id, l2DisplayName, pipe-delimited L3 display names] */
type L2Spec = [string, string, string];

interface L1Spec {
  id: string;
  name: string;
  l2: L2Spec[];
}

const SPEC: L1Spec[] = [
  {
    id: 'tech',
    name: 'Tech and gadgets',
    l2: [
      ['keyboards', 'Keyboards and input', 'Mechanical keyboards|Low-profile keyboards|Keycap sets|Switches and lubricants|Ergonomic keyboards|Mice|Trackballs|Macropads'],
      ['laptops', 'Laptops and tablets', 'Ultrabooks|Gaming laptops|Chromebooks|Android tablets|iPads|E-readers|Laptop stands|Docking stations'],
      ['phones', 'Phones and accessories', 'Smartphones|Phone cases|Screen protectors|Power banks|Wireless chargers|Car mounts|Phone camera grips|Magnetic accessories'],
      ['wearables', 'Wearables', 'Smartwatches|Fitness trackers|Smart rings|Watch bands|VR headsets|Smart glasses|Sleep trackers|Heart rate straps'],
      ['smarthome', 'Smart home', 'Smart speakers|Smart bulbs|Smart plugs|Robot vacuums|Video doorbells|Indoor cameras|Smart locks|Thermostats'],
      ['storage', 'Storage and networking', 'External SSDs|NAS enclosures|Portable hard drives|Wi-Fi routers|Mesh systems|Network switches|USB hubs|Memory cards'],
      ['pcparts', 'PC components', 'Graphics cards|Processors|Motherboards|Memory kits|Power supplies|PC cases|CPU coolers|Case fans'],
      ['monitors', 'Monitors and displays', '4K monitors|Ultrawide monitors|OLED monitors|Portable monitors|Monitor arms|Projectors|Colour calibrators|KVM switches'],
      ['drones', 'Drones and RC', 'Camera drones|FPV drones|RC cars|RC planes|Drone batteries|Handheld gimbals|Flight controllers|Propellers'],
      ['diyelectronics', 'DIY electronics', 'Single-board computers|Microcontrollers|Sensor kits|Soldering stations|Oscilloscopes|Multimeters|Breadboards|3D printers'],
    ],
  },
  {
    id: 'home',
    name: 'Home and kitchen',
    l2: [
      ['cookware', 'Cookware', 'Cast iron skillets|Carbon steel pans|Stainless saucepans|Dutch ovens|Woks|Nonstick pans|Stockpots|Griddles'],
      ['knives', 'Knives and cutting', 'Chef knives|Santoku knives|Paring knives|Knife blocks|Whetstones|Cutting boards|Kitchen shears|Cleavers'],
      ['coffee', 'Coffee and tea', 'Espresso machines|Pour-over kits|Burr grinders|French presses|Moka pots|Milk frothers|Electric kettles|Teapots'],
      ['smallappliance', 'Small appliances', 'Air fryers|Stand mixers|Blenders|Food processors|Toaster ovens|Rice cookers|Sous vide circulators|Pressure cookers'],
      ['tableware', 'Tableware', 'Dinnerware sets|Stoneware bowls|Glassware|Flatware sets|Mugs|Serving platters|Carafes|Chopstick sets'],
      ['storagekitchen', 'Kitchen storage', 'Food containers|Spice racks|Pantry jars|Drawer organisers|Bread boxes|Vacuum sealers|Dish racks|Kitchen bins'],
      ['bedding', 'Bedding', 'Duvet inserts|Linen sheet sets|Percale sheets|Weighted blankets|Pillows|Mattress toppers|Quilts|Duvet covers'],
      ['bath', 'Bath', 'Towel sets|Bath mats|Shower heads|Shower curtains|Bathrobes|Soap dispensers|Vanity mirrors|Bathroom carts'],
      ['cleaning', 'Cleaning and laundry', 'Cordless vacuums|Steam mops|Air purifiers|Humidifiers|Laundry baskets|Drying racks|Garment steamers|Cleaning kits'],
      ['hometools', 'Home tools', 'Cordless drills|Tool sets|Stud finders|Step ladders|Label makers|Tape measures|Workbenches|Safety gear'],
    ],
  },
  {
    id: 'furniture',
    name: 'Furniture and decor',
    l2: [
      ['seating', 'Seating', 'Lounge chairs|Sofas|Sectionals|Accent chairs|Bar stools|Benches|Recliners|Poufs'],
      ['desks', 'Desks and office', 'Standing desks|Writing desks|Office chairs|Desk shelves|Filing cabinets|Monitor risers|Drafting tables|Desk mats'],
      ['tables', 'Tables', 'Dining tables|Coffee tables|Side tables|Console tables|Nesting tables|Bistro tables|Extendable tables|Nightstands'],
      ['storagefurniture', 'Storage furniture', 'Bookcases|Sideboards|Dressers|Wardrobes|Shoe cabinets|Media consoles|Storage benches|Cube shelving'],
      ['beds', 'Beds', 'Platform beds|Upholstered beds|Bed frames|Headboards|Bunk beds|Daybeds|Mattresses|Futons'],
      ['lighting', 'Lighting', 'Floor lamps|Table lamps|Pendant lights|Wall sconces|Track lighting|Desk lamps|String lights|Smart lamps'],
      ['rugs', 'Rugs and textiles', 'Area rugs|Runners|Vintage rugs|Throw blankets|Cushion covers|Curtains|Tapestries|Doormats'],
      ['wallart', 'Wall art', 'Framed prints|Canvas art|Posters|Photography prints|Wall mirrors|Wall shelves|Wall clocks|Gallery frames'],
      ['plants', 'Plants and planters', 'Indoor plants|Planters|Grow lights|Hanging planters|Watering cans|Plant stands|Terrariums|Potting soil'],
      ['outdoorfurniture', 'Outdoor furniture', 'Patio sets|Outdoor lounge chairs|Hammocks|Fire pits|Parasols|Garden benches|Outdoor rugs|Planter boxes'],
    ],
  },
  {
    id: 'fashion-men',
    name: 'Fashion (men)',
    l2: [
      ['mentops', "Men's tops", 'T-shirts|Oxford shirts|Flannel shirts|Polos|Henleys|Sweatshirts|Hoodies|Knit sweaters'],
      ['menouterwear', "Men's outerwear", 'Field jackets|Trench coats|Down parkas|Denim jackets|Leather jackets|Bomber jackets|Overshirts|Raincoats'],
      ['menbottoms', "Men's bottoms", 'Selvedge jeans|Chinos|Wool trousers|Cargo pants|Shorts|Joggers|Corduroy trousers|Swim trunks'],
      ['mentailoring', 'Tailoring', 'Suits|Blazers|Dress shirts|Waistcoats|Tuxedos|Dress trousers|Ties|Pocket squares'],
      ['menshoes', "Men's shoes", 'Derbies|Loafers|Chelsea boots|Work boots|Oxford shoes|Sandals|Boat shoes|Espadrilles'],
      ['menaccessories', "Men's accessories", 'Leather belts|Wallets|Scarves|Gloves|Beanies|Caps|Sunglasses|Cufflinks'],
      ['menbags', "Men's bags", 'Briefcases|Messenger bags|Backpacks|Weekender bags|Totes|Dopp kits|Sling bags|Laptop sleeves'],
      ['menbasics', 'Underwear and socks', 'Boxer briefs|Undershirts|Dress socks|Athletic socks|Wool socks|Loungewear|Pyjamas|Robes'],
      ['menworkwear', 'Workwear', 'Chore coats|Duck canvas pants|Coveralls|Work shirts|Aprons|Tool belts|Heavyweight tees|Insulated vests'],
      ['menvintage', 'Vintage menswear', 'Vintage denim|Vintage tees|Military surplus|Vintage knitwear|Archive pieces|Vintage jackets|Deadstock menswear|Repro workwear'],
    ],
  },
  {
    id: 'fashion-women',
    name: 'Fashion (women)',
    l2: [
      ['womendresses', 'Dresses', 'Midi dresses|Maxi dresses|Slip dresses|Wrap dresses|Shirt dresses|Knit dresses|Occasion dresses|Sundresses'],
      ['womentops', "Women's tops", 'Blouses|Knit tops|Womens tees|Bodysuits|Cardigans|Womens sweaters|Camisoles|Tunics'],
      ['womenbottoms', "Women's bottoms", 'Wide-leg trousers|Straight jeans|Mom jeans|Midi skirts|Mini skirts|Tailored shorts|Leggings|Culottes'],
      ['womenouterwear', "Women's outerwear", 'Wool coats|Womens trench coats|Puffer jackets|Womens blazers|Womens leather jackets|Womens denim jackets|Capes|Womens raincoats'],
      ['womenshoes', "Women's shoes", 'Ankle boots|Knee boots|Womens loafers|Ballet flats|Heeled sandals|Mules|Pumps|Slides'],
      ['womenbags', "Women's bags", 'Shoulder bags|Crossbody bags|Womens totes|Clutches|Bucket bags|Womens backpacks|Mini bags|Top-handle bags'],
      ['womenaccessories', "Women's accessories", 'Silk scarves|Womens belts|Hats|Hair accessories|Womens gloves|Womens sunglasses|Womens wallets|Keychains'],
      ['womenlingerie', 'Lingerie and loungewear', 'Bras|Briefs|Slips|Womens robes|Pyjama sets|Camisole sets|Shapewear|Sleep shirts'],
      ['womenactive', 'Activewear', 'Womens leggings|Sports bras|Running shorts|Track jackets|Tennis skirts|Yoga sets|Swimsuits|Cover-ups'],
      ['womenvintage', 'Vintage womenswear', 'Vintage dresses|Vintage coats|Archive designer|Vintage womens knitwear|Vintage womens denim|Vintage silk scarves|Deadstock womenswear|Reworked pieces'],
    ],
  },
  {
    id: 'sneakers',
    name: 'Sneakers and streetwear',
    l2: [
      ['runningsneakers', 'Running sneakers', 'Daily trainers|Carbon plate racers|Trail runners|Stability shoes|Max cushion shoes|Retro runners|Track spikes|Recovery slides'],
      ['basketballsneakers', 'Basketball sneakers', 'Signature models|Retro basketball|High tops|Low tops|Outdoor models|Team colourways|Player exclusives|Basketball collabs'],
      ['lifestylesneakers', 'Lifestyle sneakers', 'Court classics|Chunky sneakers|Skate shoes|Canvas sneakers|Slip-ons|Suede low tops|Terrace shoes|Dad shoes'],
      ['streetweartops', 'Streetwear tops', 'Graphic tees|Box-logo hoodies|Crewnecks|Streetwear work jackets|Coaches jackets|Rugby shirts|Long sleeve tees|Varsity jackets'],
      ['streetwearbottoms', 'Streetwear bottoms', 'Streetwear cargos|Baggy jeans|Sweatpants|Nylon track pants|Mesh shorts|Carpenter pants|Parachute pants|Denim shorts'],
      ['headwear', 'Headwear', 'Fitted caps|Dad hats|Streetwear beanies|Bucket hats|Trucker caps|Five-panel caps|Balaclavas|Snapbacks'],
      ['streetwearaccessories', 'Streetwear accessories', 'Streetwear crossbodies|Logo socks|Streetwear belts|Streetwear keychains|Streetwear phone cases|Lanyards|Patches|Enamel pins'],
      ['sneakercare', 'Sneaker care', 'Cleaning kits|Protector sprays|Replacement laces|Crease protectors|Shoe trees|Display cases|Deodorisers|Sole guards'],
      ['collabs', 'Collaborations', 'Designer collabs|Artist collabs|Brand collabs|Regional exclusives|Sample pairs|Friends and family|Anniversary releases|Reissues'],
      ['streetweararchive', 'Archive streetwear', 'Archive tees|Vintage sportswear|Deadstock sneakers|Y2K pieces|Skate archive|Band merchandise|Rap tees|Vintage streetwear outerwear'],
    ],
  },
  {
    id: 'watches',
    name: 'Watches and jewelry',
    l2: [
      ['divewatches', 'Dive watches', 'Skin divers|300m divers|Bronze divers|Dive reissues|Titanium divers|Dive chronographs|Field-diver hybrids|Saturation divers'],
      ['dresswatches', 'Dress watches', 'Ultra-thin dress watches|Guilloche dials|Enamel dials|Moonphase watches|Small seconds|Roman dial watches|Two-tone dress watches|Gold dress watches'],
      ['chronographs', 'Chronographs', 'Panda dials|Racing chronographs|Pilot chronographs|Flyback chronographs|Monopushers|Meca-quartz chronographs|Telemeter dials|Bullhead chronographs'],
      ['toolwatches', 'Tool watches', 'Field watches|Pilot watches|GMT watches|Dive computers|Solar tool watches|Titanium field watches|Ana-digi watches|Compressor cases'],
      ['vintagewatches', 'Vintage watches', 'Sixties divers|Vintage mechanical dress|Vintage chronographs|Military issue watches|Tropical dials|New old stock|Vintage quartz|Pocket watches'],
      ['watchstraps', 'Straps and parts', 'Leather straps|NATO straps|Watch bracelets|Rubber straps|Buckles|Spring bars|Watch crystals|Bezel inserts'],
      ['rings', 'Rings', 'Signet rings|Wedding bands|Engagement rings|Stacking rings|Silver rings|Gemstone rings|Statement rings|Enamel rings'],
      ['necklaces', 'Necklaces', 'Chains|Pendants|Chokers|Lockets|Pearl strands|Layered sets|Charm necklaces|Cuban links'],
      ['earrings', 'Earrings', 'Studs|Hoops|Drop earrings|Ear cuffs|Huggies|Threaders|Ear climbers|Clip-ons'],
      ['finejewelry', 'Fine jewelry', 'Diamond pieces|Gold bracelets|Estate jewelry|Gemstone pendants|Platinum bands|Antique brooches|Tennis bracelets|Signed designer jewelry'],
    ],
  },
  {
    id: 'beauty',
    name: 'Beauty and grooming',
    l2: [
      ['skincare', 'Skincare', 'Cleansers|Serums|Moisturisers|Sunscreens|Exfoliants|Eye creams|Face masks|Toners'],
      ['makeup', 'Makeup', 'Foundations|Concealers|Lipsticks|Mascaras|Eyeshadow palettes|Blushes|Brow products|Setting sprays'],
      ['haircare', 'Hair care', 'Shampoos|Conditioners|Hair oils|Styling creams|Dry shampoos|Scalp treatments|Hair masks|Heat protectants'],
      ['hairtools', 'Hair tools', 'Hair dryers|Straighteners|Curling wands|Diffusers|Hair clippers|Hair trimmers|Brush sets|Hot brushes'],
      ['shaving', 'Shaving', 'Safety razors|Straight razors|Shaving brushes|Shaving soaps|Aftershaves|Cartridge razors|Razor blades|Razor stands'],
      ['fragrance', 'Fragrance', 'Eau de parfum|Eau de toilette|Extrait de parfum|Niche fragrance|Discovery sets|Solid perfume|Body mists|Incense'],
      ['nails', 'Nails', 'Nail polishes|Gel kits|Nail files|Cuticle care|Press-on nails|Base coats|Top coats|Nail lamps'],
      ['bathbody', 'Bath and body', 'Body washes|Body lotions|Body oils|Body scrubs|Deodorants|Hand creams|Bath salts|Soap bars'],
      ['grooming', "Men's grooming", 'Beard oils|Beard balms|Pomades|Mens face wash|Beard trimmers|Moustache wax|Grooming kits|Hair clay'],
      ['beautytools', 'Beauty tools', 'Makeup brushes|Makeup sponges|Gua sha|Face rollers|LED masks|Tweezers|Lash curlers|Compact mirrors'],
    ],
  },
  {
    id: 'fitness',
    name: 'Fitness and outdoors',
    l2: [
      ['strength', 'Strength training', 'Adjustable dumbbells|Kettlebells|Barbells|Weight plates|Power racks|Weight benches|Resistance bands|Lifting belts'],
      ['cardio', 'Cardio equipment', 'Treadmills|Exercise bikes|Rowing machines|Ellipticals|Jump ropes|Steppers|Air bikes|Ski ergs'],
      ['yoga', 'Yoga and recovery', 'Yoga mats|Yoga blocks|Foam rollers|Massage guns|Yoga straps|Bolsters|Balance boards|Compression boots'],
      ['running', 'Running gear', 'Running vests|Hydration packs|GPS watches|Running belts|Reflective gear|Running socks|Running sunglasses|Race kit'],
      ['camping', 'Camping', 'Tents|Sleeping bags|Sleeping pads|Camp stoves|Headlamps|Camp chairs|Lanterns|Cool boxes'],
      ['hiking', 'Hiking', 'Hiking boots|Approach shoes|Trekking poles|Daypacks|Rain shells|Base layers|Gaiters|Navigation tools'],
      ['climbing', 'Climbing', 'Climbing shoes|Harnesses|Chalk bags|Climbing ropes|Quickdraws|Belay devices|Crash pads|Climbing helmets'],
      ['watersports', 'Water sports', 'Paddle boards|Kayaks|Wetsuits|Dry bags|Snorkel sets|Surfboards|Buoyancy aids|Swim goggles'],
      ['wintersports', 'Winter sports', 'Skis|Snowboards|Ski boots|Snowboard bindings|Ski goggles|Snow helmets|Thermal base layers|Ski poles'],
      ['cycling', 'Cycling', 'Road bikes|Gravel bikes|Mountain bikes|Bike helmets|Bike lights|Cycling shoes|Bike bags|Turbo trainers'],
    ],
  },
  {
    id: 'sports',
    name: 'Sports gear',
    l2: [
      ['basketballgear', 'Basketball', 'Basketballs|Basketball hoops|Shooting sleeves|Basketball jerseys|Court shoes|Training aids|Ball pumps|Scoreboards'],
      ['soccer', 'Soccer', 'Soccer balls|Soccer cleats|Shin guards|Goalkeeper gloves|Portable goals|Training cones|Soccer jerseys|Ball pump kits'],
      ['racquet', 'Tennis and racquet', 'Tennis racquets|Padel racquets|Pickleball paddles|Tennis balls|Racquet grips|Racquet strings|Racquet bags|Ball machines'],
      ['golf', 'Golf', 'Drivers|Irons|Putters|Golf balls|Golf bags|Rangefinders|Golf gloves|Push carts'],
      ['baseball', 'Baseball', 'Baseball gloves|Baseball bats|Batting gloves|Catcher gear|Baseballs|Baseball cleats|Batting helmets|Pitching nets'],
      ['combat', 'Combat sports', 'Boxing gloves|Heavy bags|Hand wraps|Mouthguards|MMA gloves|Headgear|Focus mitts|Gi and belts'],
      ['skate', 'Skate', 'Complete skateboards|Skate decks|Skate trucks|Skate wheels|Bearings|Skate tools|Skate pads|Skate footwear'],
      ['tablesports', 'Table sports', 'Table tennis paddles|Ping pong tables|Dart boards|Pool cues|Foosball tables|Air hockey tables|Shuffleboards|Billiard balls'],
      ['fishing', 'Fishing', 'Fishing rods|Fishing reels|Lures|Tackle boxes|Fishing lines|Waders|Landing nets|Fish finders'],
      ['fanwear', 'Team fanwear', 'Replica jerseys|Team caps|Team scarves|Match kits|Vintage jerseys|Pennants|Team jackets|Collectible balls'],
    ],
  },
  {
    id: 'audio',
    name: 'Music and audio',
    l2: [
      ['headphones', 'Headphones', 'Over-ear headphones|On-ear headphones|Open-back headphones|Closed-back headphones|Noise cancelling headphones|Wireless headphones|Studio headphones|Audiophile flagships'],
      ['earbuds', 'Earbuds', 'True wireless earbuds|Wired IEMs|Custom IEMs|Sport earbuds|Noise cancelling earbuds|Budget IEMs|Open earbuds|Bone conduction'],
      ['speakers', 'Speakers', 'Bookshelf speakers|Floorstanding speakers|Portable speakers|Wireless speakers|Studio monitors|Subwoofers|Soundbars|Outdoor speakers'],
      ['ampsdacs', 'Amps and DACs', 'Headphone amps|Desktop DACs|Portable DACs|Integrated amplifiers|Tube amplifiers|Phono stages|Network streamers|Power conditioners'],
      ['turntables', 'Turntables and vinyl', 'Turntables|Cartridges|Styli|Record cleaners|Vinyl storage|Slipmats|Isolation feet|LP records'],
      ['guitars', 'Guitars', 'Electric guitars|Acoustic guitars|Bass guitars|Guitar amps|Effects pedals|Guitar strings|Guitar cases|Capos'],
      ['synths', 'Keyboards and synths', 'Synthesizers|Digital pianos|MIDI controllers|Drum machines|Samplers|Eurorack modules|Stage pianos|Sustain pedals'],
      ['drums', 'Drums and percussion', 'Acoustic drum kits|Electronic drum kits|Cymbals|Snare drums|Drum sticks|Practice pads|Hand percussion|Drum hardware'],
      ['studio', 'Studio gear', 'Audio interfaces|Studio microphones|Mic stands|Pop filters|Acoustic panels|Monitor stands|Patch cables|Field recorders'],
      ['djgear', 'DJ gear', 'DJ controllers|DJ mixers|Media players|DJ headphones|Flight cases|Stage lighting|DJ cartridges|Booth monitors'],
    ],
  },
  {
    id: 'gaming',
    name: 'Gaming',
    l2: [
      ['consoles', 'Consoles', 'Home consoles|Handheld consoles|Retro consoles|Console bundles|Mini consoles|Console docks|Console storage|Faceplates'],
      ['games', 'Games', 'New releases|Sealed games|Retro cartridges|Collector editions|Import games|Game bundles|Game codes|Strategy guides'],
      ['controllers', 'Controllers', 'Pro controllers|Fight sticks|Racing wheels|Flight sticks|Retro pads|Controller grips|Charging docks|Thumbsticks'],
      ['pcgaming', 'PC gaming', 'Gaming mice|Gaming keyboards|Mouse pads|Gaming headsets|Stream decks|Capture cards|Gaming chairs|Webcams'],
      ['vr', 'VR and AR', 'VR headsets|VR controllers|Face interfaces|Link cables|Haptic vests|VR treadmills|Lens inserts|Head straps'],
      ['tabletop', 'Tabletop games', 'Board games|Card games|Miniatures|Dice sets|RPG books|Game mats|Miniature paints|Storage inserts'],
      ['tcg', 'Trading card games', 'Booster boxes|Single cards|Graded cards|Card sleeves|Deck boxes|Card binders|Playmats|Starter decks'],
      ['arcade', 'Arcade and pinball', 'Arcade cabinets|Pinball machines|Arcade sticks|Coin mechanisms|Marquee art|CRT monitors|Control panels|Arcade boards'],
      ['gamingsetup', 'Gaming setup', 'Gaming desks|Gaming monitor arms|RGB lighting|Cable management|Headset stands|Console shelves|Acoustic foam|Desk pads'],
      ['gamingcollect', 'Gaming collectibles', 'Gaming figures|Art books|Game soundtracks|Plush toys|Prop replicas|Gaming pins|Gaming posters|Collectible figurines'],
    ],
  },
  {
    id: 'books',
    name: 'Books and stationery',
    l2: [
      ['fiction', 'Fiction', 'Literary fiction|Science fiction|Fantasy|Crime and mystery|Horror|Historical fiction|Short stories|Graphic novels'],
      ['nonfiction', 'Non-fiction', 'Biography|History|Popular science|Philosophy|Economics|Essays|Travel writing|Popular psychology'],
      ['artbooks', 'Art and design books', 'Photography books|Artist monographs|Architecture books|Typography books|Exhibition catalogues|Fashion books|Design theory|Zines'],
      ['rarebooks', 'Rare and collectible books', 'First editions|Signed copies|Antiquarian books|Limited print runs|Out-of-print books|Slipcased sets|Fine bindings|Paper ephemera'],
      ['notebooks', 'Notebooks', 'Hardcover notebooks|Softcover notebooks|Dot grid notebooks|Pocket notebooks|Sketchbooks|Planners|Journals|Notebook refills'],
      ['pens', 'Pens and ink', 'Fountain pens|Rollerballs|Ballpoints|Gel pens|Mechanical pencils|Fountain pen ink|Ink cartridges|Pen nibs'],
      ['deskstationery', 'Desk stationery', 'Desk organisers|Paper trays|Staplers|Desk scissors|Tape dispensers|Rulers|Letter openers|Pen cups'],
      ['paper', 'Paper and cards', 'Writing paper|Greeting cards|Postcards|Envelopes|Washi tape|Stickers|Gift wrap|Card stock'],
      ['calligraphy', 'Calligraphy', 'Dip pens|Brush pens|Calligraphy ink|Practice pads|Nib holders|Guide sheets|Gouache sets|Wax seals'],
      ['comics', 'Comics and manga', 'Single issues|Trade paperbacks|Manga volumes|Omnibus editions|Graded comics|Variant covers|Webcomic collections|Art of books'],
    ],
  },
  {
    id: 'art',
    name: 'Art and collectibles',
    l2: [
      ['prints', 'Prints and editions', 'Screen prints|Giclee prints|Lithographs|Etchings|Risograph prints|Artist proofs|Open editions|Signed prints'],
      ['originalart', 'Original art', 'Oil paintings|Acrylic paintings|Watercolours|Mixed media|Drawings|Collage|Small works|Studies'],
      ['sculpture', 'Sculpture and objects', 'Ceramics|Bronze sculpture|Wood carving|Glass objects|Resin art|Kinetic sculpture|Found object art|Studio pottery'],
      ['photoart', 'Photographic art', 'Silver gelatin prints|C-prints|Polaroids|Photo portfolios|Vintage press photos|Contact sheets|Photo zines|Limited photo editions'],
      ['designobjects', 'Design objects', 'Mid-century objects|Bauhaus pieces|Postmodern design|Italian design|Scandinavian objects|Studio furniture|Designer lighting|Industrial design'],
      ['antiques', 'Antiques', 'Victorian pieces|Art deco objects|Militaria|Scientific instruments|Antique clocks|Silverware|Antique maps|Asian antiques'],
      ['coins', 'Coins and currency', 'Graded coins|Bullion|Ancient coins|Commemorative sets|Banknotes|Error coins|Coin albums|Trade tokens'],
      ['stamps', 'Stamps and philately', 'Classic stamp issues|First day covers|Mint sheets|Stamp albums|Postal history|Stamp varieties|Thematic collections|Revenue stamps'],
      ['memorabilia', 'Memorabilia', 'Concert posters|Signed items|Film props|Sports memorabilia|Vintage advertising|Badges|Tour merchandise|Historical documents'],
      ['artsupplies', 'Art supplies', 'Oil paints|Acrylic paints|Watercolour sets|Art brushes|Canvases|Easels|Pastels|Palette knives'],
    ],
  },
  {
    id: 'photography',
    name: 'Photography',
    l2: [
      ['mirrorless', 'Mirrorless cameras', 'Full-frame mirrorless|APS-C mirrorless|Micro four thirds|Medium format digital|Compact mirrorless|Cinema cameras|Early digital bodies|Body-only listings'],
      ['dslr', 'DSLR cameras', 'Full-frame DSLRs|Crop-sensor DSLRs|Professional DSLR bodies|Entry-level DSLRs|Used DSLRs|Battery grips|Screen protectors|Focusing screens'],
      ['filmcameras', 'Film cameras', '35mm SLRs|Rangefinders|Point and shoots|Medium format film|Large format|Instant cameras|Half-frame cameras|Toy cameras'],
      ['lenses', 'Lenses', 'Prime lenses|Zoom lenses|Wide-angle lenses|Telephoto lenses|Macro lenses|Tilt-shift lenses|Vintage lenses|Lens adapters'],
      ['photolighting', 'Photo lighting', 'Speedlights|Studio strobes|Continuous lights|Softboxes|Light stands|Reflectors|Flash triggers|Light meters'],
      ['support', 'Camera support', 'Tripods|Monopods|Ball heads|Gimbal heads|Camera sliders|Camera cages|Shoulder rigs|Suction mounts'],
      ['darkroom', 'Film and darkroom', 'Colour film|Black and white film|Instant film|Developing tanks|Enlargers|Darkroom chemistry|Film scanners|Changing bags'],
      ['camerabags', 'Camera bags', 'Camera backpacks|Camera shoulder bags|Hard cases|Insert dividers|Memory card cases|Camera slings|Lens pouches|Rain covers'],
      ['filters', 'Filters and accessories', 'ND filters|Polarisers|UV filters|Filter holders|Lens hoods|Lens caps|Sensor cleaning kits|Remote releases'],
      ['videoaccessories', 'Video accessories', 'External monitors|Audio field recorders|Camera microphones|Follow focus|Matte boxes|Camera gimbals|V-mount batteries|SDI cables'],
    ],
  },
  {
    id: 'auto',
    name: 'Auto and moto',
    l2: [
      ['carparts', 'Car parts', 'Brake kits|Coilovers|Exhaust systems|Air intakes|Spark plugs|Engine filters|Radiators|Clutch kits'],
      ['wheelstyres', 'Wheels and tyres', 'Alloy wheels|Winter tyres|Summer tyres|All-season tyres|Wheel spacers|Lug nuts|TPMS sensors|Hub caps'],
      ['carinterior', 'Car interior', 'Seat covers|Floor mats|Steering wheels|Shift knobs|Bucket seats|Dash cams|Car phone mounts|Sunshades'],
      ['carelectronics', 'Car electronics', 'Head units|Car speakers|Car amplifiers|Car subwoofers|Backup cameras|OBD scanners|Radar detectors|Wiring kits'],
      ['garagetools', 'Garage tools', 'Trolley jacks|Torque wrenches|Socket sets|Diagnostic tools|Creepers|Air compressors|Battery chargers|Work lights'],
      ['detailing', 'Detailing', 'Ceramic coatings|Car waxes|Polishers|Microfibre towels|Wash mitts|Clay bars|Wheel cleaners|Interior cleaners'],
      ['motoparts', 'Motorcycle parts', 'Motorcycle exhausts|Sprockets and chains|Motorcycle brake pads|Levers|Motorcycle mirrors|Crash protection|Motorcycle seats|Luggage racks'],
      ['motogear', 'Riding gear', 'Motorcycle helmets|Riding jackets|Riding gloves|Riding boots|Back protectors|Riding jeans|Riding base layers|Neck tubes'],
      ['motorcycles', 'Motorcycles', 'Sport bikes|Naked bikes|Cruisers|Adventure bikes|Cafe racers|Scooters|Dirt bikes|Vintage motorcycles'],
      ['automobilia', 'Automobilia', 'Scale models|Vintage garage signs|Racing posters|Racing team memorabilia|Vintage manuals|Hood ornaments|Die-cast cars|Helmet replicas'],
    ],
  },
  {
    id: 'pets',
    name: 'Pets',
    l2: [
      ['dogfood', 'Dog food and treats', 'Dry dog food|Wet dog food|Raw dog food|Dog treats|Dental chews|Dog supplements|Puppy food|Food toppers'],
      ['dogwalking', 'Dog walking', 'Dog harnesses|Dog leads|Dog collars|Long lines|Pet tags|Waste bag holders|Reflective dog gear|Training leads'],
      ['dogcomfort', 'Dog comfort', 'Dog beds|Dog crates|Dog blankets|Crate mats|Cooling mats|Playpens|Dog car seats|Travel crates'],
      ['dogtoys', 'Dog toys', 'Chew toys|Rope toys|Puzzle feeders|Fetch toys|Squeaky toys|Snuffle mats|Tug toys|Treat dispensers'],
      ['catessentials', 'Cat essentials', 'Litter boxes|Cat litter|Litter mats|Litter scoops|Odour control|Automatic litter boxes|Litter disposal|Litter enclosures'],
      ['catfurniture', 'Cat furniture', 'Cat trees|Scratching posts|Window perches|Cat shelves|Cat tunnels|Cat beds|Cat hideaways|Cat doors'],
      ['cattoys', 'Cat toys', 'Wand toys|Laser toys|Catnip toys|Ball tracks|Cat puzzle toys|Kicker toys|Feather toys|Automatic cat toys'],
      ['smallpets', 'Small pets', 'Rabbit hutches|Hamster cages|Guinea pig runs|Small pet bedding|Exercise wheels|Chew blocks|Water bottles|Travel carriers'],
      ['aquarium', 'Aquariums', 'Aquarium tanks|Aquarium filters|Aquarium heaters|Aquarium lights|Substrate|Air pumps|Water test kits|Aquarium decor'],
      ['petgrooming', 'Pet grooming', 'Pet brushes|Pet clippers|Pet shampoos|Nail clippers|Deshedding tools|Grooming tables|Ear cleaners|Pet toothbrushes'],
    ],
  },
  {
    id: 'kids',
    name: 'Kids and baby',
    l2: [
      ['strollers', 'Strollers and carriers', 'Travel systems|Lightweight strollers|Double strollers|Jogging strollers|Baby carriers|Slings|Stroller organisers|Stroller rain covers'],
      ['carseats', 'Car seats', 'Infant seats|Convertible seats|Booster seats|Isofix bases|Seat protectors|Head supports|Back seat mirrors|Car seat travel bags'],
      ['nursery', 'Nursery', 'Cribs|Bassinets|Changing tables|Nursery dressers|Rocking chairs|Night lights|Baby monitors|Cot mobiles'],
      ['feeding', 'Feeding', 'Baby bottles|Sterilisers|Breast pumps|High chairs|Bibs|Weaning sets|Formula dispensers|Bottle warmers'],
      ['babyclothes', 'Baby clothing', 'Bodysuits|Sleepsuits|Rompers|Baby knitwear|Booties|Hats and mittens|Baby outerwear|Swaddles'],
      ['kidsclothes', 'Kids clothing', 'Kids tees|Kids jeans|Kids dresses|Kids jumpers|Kids coats|Kids pyjamas|School uniform|Kids shoes'],
      ['babytoys', 'Baby toys', 'Rattles|Teethers|Play gyms|Soft books|Stacking toys|Bath toys|Sensory toys|Push walkers'],
      ['kidstoys', 'Kids toys', 'Building blocks|Action figures|Dolls|Ride-ons|Science kits|Art sets|Puzzles|Outdoor toys'],
      ['kidsfurniture', 'Kids furniture', 'Toddler beds|Kids bunk beds|Play tables|Toy storage|Kids bookshelves|Step stools|Play tents|Kids desks'],
      ['kidssafety', 'Child safety', 'Stair gates|Cabinet locks|Corner guards|Socket covers|Anti-tip straps|Bed rails|Door stoppers|Window locks'],
    ],
  },
];

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const nodes: CategoryNode[] = [];

/**
 * Ids are unique across all three levels, so the L1 and L2 ids are reserved
 * before any L3 slug is minted. Without this, the `turntables` L2 and its
 * `Turntables` leaf would collide.
 */
const takenSlugs = new Set<string>();
for (const l1 of SPEC) {
  takenSlugs.add(l1.id);
  for (const [l2Id] of l1.l2) takenSlugs.add(l2Id);
}

for (const [l1Index, l1] of SPEC.entries()) {
  nodes.push({
    id: l1.id,
    level: 1,
    parent: null,
    l1: l1.id,
    displayName: l1.name,
    tileOrder: l1Index,
  });

  for (const [l2Id, l2Name, l3Blob] of l1.l2) {
    nodes.push({
      id: l2Id,
      level: 2,
      parent: l1.id,
      l1: l1.id,
      displayName: l2Name,
      tileOrder: null,
    });

    for (const l3Name of l3Blob.split('|')) {
      const bare = slugify(l3Name);
      const id = takenSlugs.has(bare) ? `${l2Id}-${bare}` : bare;
      takenSlugs.add(id);
      nodes.push({
        id,
        level: 3,
        parent: l2Id,
        l1: l1.id,
        displayName: l3Name,
        tileOrder: null,
      });
    }
  }
}

/** Every node in the taxonomy, L1 first, then L2, then L3, in authored order. */
export const CATEGORY_NODES: readonly CategoryNode[] = Object.freeze(nodes);

const byId = new Map<string, CategoryNode>();
for (const n of nodes) byId.set(n.id, n);

export const L1_TOPICS: readonly CategoryNode[] = Object.freeze(
  nodes.filter((n) => n.level === 1),
);
export const L2_TOPICS: readonly CategoryNode[] = Object.freeze(
  nodes.filter((n) => n.level === 2),
);
export const L3_TOPICS: readonly CategoryNode[] = Object.freeze(
  nodes.filter((n) => n.level === 3),
);

/** The 18 L1 topic ids, in onboarding tile order. */
export const L1_IDS: readonly string[] = Object.freeze(L1_TOPICS.map((n) => n.id));

export function getCategory(id: string): CategoryNode | undefined {
  return byId.get(id);
}

export function childrenOf(id: string): CategoryNode[] {
  return nodes.filter((n) => n.parent === id);
}

/** Resolves an L3 id to its full `{ l1, l2, l3 }` path. Throws on unknown ids. */
export function categoryPath(l3Id: string): { l1: string; l2: string; l3: string } {
  const l3 = byId.get(l3Id);
  if (!l3 || l3.level !== 3) throw new Error(`Unknown L3 category: ${l3Id}`);
  return { l1: l3.l1, l2: l3.parent as string, l3: l3.id };
}

export function isL1(id: string): boolean {
  return byId.get(id)?.level === 1;
}
