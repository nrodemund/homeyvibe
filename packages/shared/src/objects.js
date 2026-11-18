// Primitive-based designs, listed with their default size in meters and finish.
const groups = {
  Seating: [
    ['Dining chair', 'chair', .48, .9, .5, '#987354'], ['Office chair', 'office', .64, 1.12, .68, '#44495a'],
    ['Armchair', 'armchair', .85, .92, .88, '#61847a'], ['Loveseat', 'sofa', 1.45, .85, .85, '#ba906e'],
    ['Three-seat sofa', 'sofa', 2.2, .87, .9, '#506980'], ['Corner sofa', 'sectional', 2.6, .87, 1.62, '#59615a'],
    ['Bench', 'bench', 1.3, .46, .38, '#966d4f'], ['Bar stool', 'stool', .42, .77, .42, '#755238'],
  ],
  Tables: [
    ['Dining table', 'table', 1.55, .75, .87, '#9f7350'], ['Round dining table', 'round-table', 1.12, .75, 1.12, '#8e603d'],
    ['Coffee table', 'table', 1, .42, .58, '#705c50'], ['Side table', 'round-table', .48, .53, .48, '#ac8055'],
    ['Office desk', 'desk', 1.45, .75, .72, '#8a6d54'], ['Standing desk', 'desk', 1.4, 1.12, .7, '#706c65'],
    ['Console table', 'table', 1.2, .81, .35, '#a98569'], ['Kitchen island', 'island', 1.75, .93, .82, '#647570'],
  ],
  Storage: [
    ['Bookcase', 'shelf', .9, 1.92, .36, '#a67c53'], ['Wall shelf', 'open-shelf', .92, .32, .25, '#ab8e6f'],
    ['Sideboard', 'cabinet', 1.62, .8, .43, '#886649'], ['Wardrobe', 'cabinet', 1.56, 2.05, .6, '#927d69'],
    ['Chest of drawers', 'drawers', 1, 1.02, .45, '#b49c7c'], ['Nightstand', 'drawers', .48, .52, .42, '#775940'],
    ['Shoe rack', 'shelf', .79, .7, .32, '#86756a'], ['Display cabinet', 'display-case', .89, 1.8, .45, '#5b6e71'],
  ],
  Bedroom: [
    ['Single bed', 'bed', 1, .96, 2.04, '#a5a1b2'], ['Double bed', 'bed', 1.68, 1, 2.1, '#8f897e'],
    ['Bunk bed', 'bunk', 1.03, 1.76, 2.1, '#a88b6b'], ['Crib', 'crib', .74, 1, 1.38, '#bc9d77'],
    ['Dressing table', 'vanity', 1.01, 1.47, .46, '#baa990'], ['Ottoman', 'pouf', .64, .43, .52, '#577b78'],
    ['Laundry hamper', 'basket', .5, .66, .5, '#b59570'], ['Room divider', 'divider', 1.42, 1.7, .16, '#a18264'],
  ],
  Kitchen: [
    ['Refrigerator', 'fridge', .66, 1.83, .65, '#acb5ba'], ['Range cooker', 'range', .61, .92, .63, '#62717d'],
    ['Dishwasher', 'dishwasher', .6, .85, .61, '#acb5ba'], ['Microwave', 'screen-box', .51, .31, .42, '#898f96'],
    ['Kitchen sink', 'sink', .92, .92, .61, '#7d94a0'], ['Wall cabinet', 'cabinet', .84, .71, .35, '#b0a28c'],
    ['Base cabinet', 'cabinet', .76, .88, .57, '#738777'], ['Coffee maker', 'coffee', .28, .37, .34, '#554c49'],
  ],
  Bathroom: [
    ['Bathtub', 'tub', .79, .58, 1.73, '#d1d9de'], ['Shower enclosure', 'shower', .91, 2.1, .91, '#7b9eaa'],
    ['Toilet', 'toilet', .42, .8, .69, '#d6d9d8'], ['Bathroom vanity', 'sink', .78, .88, .48, '#9e8170'],
    ['Mirror', 'mirror', .64, .76, .05, '#73939f'], ['Washing machine', 'washer', .62, .89, .62, '#b7c0c3'],
    ['Towel rack', 'rack', .7, .88, .21, '#a0958e'], ['Bath mat', 'rug', .66, .027, .43, '#6d8997'],
  ],
  'Lighting and electronics': [
    ['Floor lamp', 'lamp', .43, 1.62, .43, '#dfab75'], ['Table lamp', 'lamp', .26, .51, .26, '#dcbb91'],
    ['Pendant lamp', 'pendant', .48, .49, .48, '#c59768'], ['Wall sconce', 'sconce', .19, .28, .19, '#c39666'],
    ['Television', 'tv', 1.17, .72, .21, '#424956'], ['Computer monitor', 'tv', .53, .43, .21, '#49566a'],
    ['Speaker', 'speaker', .24, .77, .26, '#4e5765'], ['Radiator', 'radiator', .94, .56, .11, '#c2c7c8'],
  ],
  'Decor and outdoors': [
    ['Area rug', 'rug', 2.15, .026, 1.48, '#977c78'], ['Round rug', 'round-rug', 1.4, .026, 1.4, '#7f8b72'],
    ['Potted plant', 'plant', .52, 1.07, .52, '#5a884d'], ['Planter box', 'planter', 1.03, .61, .38, '#7c8a65'],
    ['Picture frame', 'mirror', .59, .47, .06, '#95806b'], ['Patio lounger', 'lounger', .64, .76, 1.82, '#8d928d'],
    ['Barbecue', 'grill', .67, 1.06, .57, '#4c5353'], ['Bicycle', 'bike', .48, 1, 1.69, '#a05a49'],
  ],
};

export const OBJECT_CATALOG = Object.entries(groups).flatMap(([category, items]) =>
  items.map(([name, shape, x, y, z, color]) => ({
    id: name.toLowerCase().replaceAll(' ', '-'), category, name, shape, size: [x, y, z], color,
  })));
export const OBJECT_TYPES = new Map(OBJECT_CATALOG.map((object) => [object.id, object]));
