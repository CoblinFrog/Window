import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  WINDOW,
  aspectOf,
  captionHeight,
  hashUnit,
  planPane,
  type PaneTileSource,
} from '@window/shared';

const VIEWPORT = { width: 390, height: 844 };

function source(overrides: Partial<PaneTileSource> & { id: string }): PaneTileSource {
  return {
    imageWidth: 1000,
    imageHeight: 1000,
    title: 'A product with a reasonably typical title',
    ...overrides,
  };
}

const PANE = [
  source({ id: 'a', imageWidth: 1000, imageHeight: 1000 }),
  source({ id: 'b', imageWidth: 1200, imageHeight: 900 }),
  source({ id: 'c', imageWidth: 800, imageHeight: 1200 }),
  source({ id: 'd', imageWidth: 1000, imageHeight: 1100 }),
];

describe('hashUnit', () => {
  it('is stable for an id and salt', () => {
    assert.equal(hashUnit('product-1', 1), hashUnit('product-1', 1));
  });

  it('separates streams by salt, so padding and gap do not move together', () => {
    assert.notEqual(hashUnit('product-1', 1), hashUnit('product-1', 2));
  });

  it('stays in [0, 1) across many ids', () => {
    for (let i = 0; i < 5000; i++) {
      const value = hashUnit(`product-${i}`, 1);
      assert.ok(value >= 0 && value < 1, `out of range: ${value}`);
    }
  });

  it('spreads ids across the range rather than clustering', () => {
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10_000; i++) buckets[Math.floor(hashUnit(`p${i}`, 7) * 10)]! += 1;
    // A uniform hash puts 1000 in each decile; allow a generous 30% band.
    for (const count of buckets) assert.ok(count > 700 && count < 1300, `skewed: ${buckets}`);
  });
});

describe('aspectOf', () => {
  it('uses the source photograph', () => {
    assert.equal(aspectOf({ imageWidth: 1000, imageHeight: 1200 }), 1.2);
  });

  it('clamps a banner and a tower into the band', () => {
    assert.equal(aspectOf({ imageWidth: 3000, imageHeight: 500 }), WINDOW.aspectMin);
    assert.equal(aspectOf({ imageWidth: 500, imageHeight: 3000 }), WINDOW.aspectMax);
  });

  it('falls back to square when dimensions are missing', () => {
    assert.equal(aspectOf({ imageWidth: 0, imageHeight: 0 }), WINDOW.aspectFallback);
  });
});

describe('planPane', () => {
  it('fills across before down, so reading order is ranked order', () => {
    const plan = planPane(PANE, VIEWPORT);
    assert.deepEqual(
      plan.tiles.map((tile) => [tile.order, tile.column, tile.row]),
      [
        [0, 0, 0],
        [1, 1, 0],
        [2, 0, 1],
        [3, 1, 1],
      ],
    );
  });

  it('gives every tile the same width and lets only the height vary', () => {
    const plan = planPane(PANE, VIEWPORT);
    for (const tile of plan.tiles) {
      assert.equal(tile.imageWidth, plan.columnWidth - tile.pad * 2);
    }
    // Four different aspect ratios, so four different heights.
    const heights = new Set(plan.tiles.map((tile) => Math.round(tile.imageHeight)));
    assert.equal(heights.size, 4);
  });

  it('is deterministic: the same pane lays out identically twice', () => {
    assert.deepEqual(planPane(PANE, VIEWPORT), planPane(PANE, VIEWPORT));
  });

  it('draws padding and gaps from inside the token bands', () => {
    for (let i = 0; i < 400; i++) {
      const plan = planPane(
        [0, 1, 2, 3].map((n) => source({ id: `pane-${i}-${n}` })),
        VIEWPORT,
      );
      for (const tile of plan.tiles) {
        assert.ok(tile.pad >= WINDOW.padMin && tile.pad <= WINDOW.padMax, `pad ${tile.pad}`);
        assert.ok(
          tile.gapBelow === 0 ||
            (tile.gapBelow >= WINDOW.rowGapMin && tile.gapBelow <= WINDOW.rowGapMax),
          `gap ${tile.gapBelow}`,
        );
      }
    }
  });

  it("spends a short pane's slack on margin, never on the images or the gaps", () => {
    const squares = [0, 1, 2, 3].map((n) =>
      source({ id: `short-${n}`, imageWidth: 1000, imageHeight: 1000, title: 'Short title' }),
    );
    // Both viewports are roomy enough that nothing has to shrink, so the only
    // difference between the plans is how much slack was centred.
    const snug = planPane(squares, { width: 390, height: 900 });
    const roomy = planPane(squares, { width: 390, height: 1100 });

    assert.equal(roomy.fitScale, 1);
    for (const tile of roomy.tiles) {
      assert.equal(Math.round(tile.imageHeight), Math.round(tile.imageWidth));
    }

    // The tiles stayed exactly as close together as they were drawn...
    assert.deepEqual(
      roomy.tiles.map((tile) => tile.gapBelow),
      snug.tiles.map((tile) => tile.gapBelow),
    );
    // ...and the whole group moved down instead.
    assert.ok(roomy.drops[0] > snug.drops[0], 'group should have been pushed down');

    // Centring adds the same amount to both columns, so the offset between them
    // stays the fraction of the viewport the hash drew.
    const offsetFraction = (plan: typeof snug, height: number): number =>
      (plan.drops[1] - plan.drops[0]) / height;
    assert.ok(
      Math.abs(offsetFraction(roomy, 1100) - offsetFraction(snug, 900)) < 0.005,
      `offset drifted: ${offsetFraction(snug, 900)} then ${offsetFraction(roomy, 1100)}`,
    );
  });

  it('centres the group rather than pinning it to either edge', () => {
    const squares = [0, 1, 2, 3].map((n) =>
      source({ id: `centre-${n}`, imageWidth: 1000, imageHeight: 1000, title: 'Short title' }),
    );
    const height = 1100;
    const plan = planPane(squares, { width: 390, height });

    const extents = ([0, 1] as const).map((column) =>
      plan.tiles
        .filter((tile) => tile.column === column)
        .reduce(
          (total, tile) =>
            total +
            tile.pad * 2 +
            tile.imageHeight +
            captionHeight(squares[tile.order]!.title, tile.imageWidth) +
            tile.gapBelow,
          plan.drops[column],
        ),
    );

    const above = plan.drops[0];
    const below = height - Math.max(...extents);
    assert.ok(above > 0, 'nothing above the group');
    assert.ok(below > 0, 'group runs to the bottom edge');
    assert.ok(above < below * 3 && below < above * 3, `lopsided: ${above} above, ${below} below`);
  });

  it('leaves the bottom card in each column with no gap below it', () => {
    const plan = planPane(PANE, VIEWPORT);
    assert.equal(plan.tiles[2]!.gapBelow, 0);
    assert.equal(plan.tiles[3]!.gapBelow, 0);
    assert.ok(plan.tiles[0]!.gapBelow > 0);
    assert.ok(plan.tiles[1]!.gapBelow > 0);
  });

  it('always hangs the right column below the left', () => {
    for (let i = 0; i < 400; i++) {
      const plan = planPane(
        [0, 1, 2, 3].map((n) => source({ id: `drop-${i}-${n}` })),
        VIEWPORT,
      );
      assert.ok(plan.drops[1] > plan.drops[0], `drops ${plan.drops}`);
    }
  });

  it('fits both columns inside the viewport across many hostile panes', () => {
    for (let i = 0; i < 600; i++) {
      const sources = [0, 1, 2, 3].map((n) =>
        source({
          id: `fit-${i}-${n}`,
          imageWidth: 400 + ((i * 7 + n * 131) % 1600),
          imageHeight: 400 + ((i * 13 + n * 57) % 2400),
          title: 'A'.repeat(20 + ((i + n) % 90)),
        }),
      );
      const plan = planPane(sources, VIEWPORT);

      for (const column of [0, 1] as const) {
        const extent = plan.tiles
          .filter((tile) => tile.column === column)
          .reduce(
            (total, tile) =>
              total +
              tile.pad * 2 +
              tile.imageHeight +
              captionHeight(sources[tile.order]!.title, tile.imageWidth) +
              tile.gapBelow,
            plan.drops[column],
          );
        // A pane is a page, not a scroll region: it has to fit or it is lost.
        assert.ok(
          extent <= VIEWPORT.height + 1,
          `pane ${i} column ${column} overflowed: ${extent} > ${VIEWPORT.height}`,
        );
      }
    }
  });

  it('never shrinks an image past the floor', () => {
    const plan = planPane(
      [0, 1, 2, 3].map((n) =>
        source({ id: `tall-${n}`, imageWidth: 400, imageHeight: 4000, title: 'A'.repeat(140) }),
      ),
      { width: 390, height: 500 },
    );
    assert.ok(plan.fitScale >= WINDOW.minFitScale);
  });

  it('leaves a comfortable pane unscaled', () => {
    assert.equal(planPane(PANE, VIEWPORT).fitScale, 1);
  });

  it('handles a short pane, which the server sends rather than padding it', () => {
    const plan = planPane(PANE.slice(0, 2), VIEWPORT);
    assert.equal(plan.tiles.length, 2);
    assert.equal(plan.tiles[0]!.gapBelow, 0);
    assert.equal(plan.tiles[1]!.gapBelow, 0);
  });

  it('handles an empty pane without dividing by zero', () => {
    const plan = planPane([], VIEWPORT);
    assert.deepEqual(plan.tiles, []);
    assert.equal(plan.fitScale, 1);
  });
});
