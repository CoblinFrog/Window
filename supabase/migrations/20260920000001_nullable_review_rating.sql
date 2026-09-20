-- Reviews may carry text without a star rating.
--
-- `ReviewItem.rating` is already `number | null` in the shared types — "null
-- when the source shows review content without a per-review star rating" — but
-- the column was never relaxed to match. Amazon exercises this constantly: of
-- 41 reviews on a typical listing, 32 arrive with no per-review star. The
-- insert then fails with 23502 and takes the whole listing's ingest with it,
-- after the product and cluster rows have already been written.
--
-- The index on rating stays valid; Postgres simply skips the nulls.

ALTER TABLE reviews ALTER COLUMN rating DROP NOT NULL;
