-- Insert four deterministic products for checkout and catalog testing.
-- This migration is idempotent and can be safely re-applied.

INSERT INTO sellers (
  id, source_domain, source_seller_id, handle, type, display_name,
  avatar_url, profile_url, metrics, policies, auction_terms,
  live_listing_count, trust, suppressed, created_at, updated_at
)
VALUES (
  '00000000-0000-4000-8000-000000000004',
  'example.com',
  'window-dummy-seller',
  'window-demo-shop',
  'retailer',
  'Window Demo Shop',
  NULL,
  'https://example.com',
  '{"rating":4.8,"reviewCount":124,"salesCount":980,"memberSince":"2026-01-01T00:00:00Z","responseTime":"under 1 hour"}'::jsonb,
  '{"returnWindowDays":30,"shippingSummary":"Free standard shipping"}'::jsonb,
  NULL,
  4,
  '{"score":0.92,"flags":[]}'::jsonb,
  false,
  NOW(),
  NOW()
)
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  live_listing_count = EXCLUDED.live_listing_count,
  updated_at = NOW();

INSERT INTO products (
  id, cluster_id, source, source_type, title, raw_title, brand, identifiers,
  category, price, original_price, shipping, condition, stock, auction, specs,
  media, seller_id, embedding, embedding_version, quality, risk, engagement,
  crawl, status, reject_reason, created_at, updated_at
)
VALUES
(
  '00000000-0000-4000-8000-000000000101', NULL,
  '{"domain":"example.com","sourceId":"window-dummy","tier":1,"url":"https://example.com/headphones"}'::jsonb,
  'new', 'Wireless Bluetooth Headphones', 'Wireless Bluetooth Headphones', 'Window Demo', '{}'::jsonb,
  '{"l1":"tech","l2":"phones","l3":"phone-accessories"}'::jsonb,
  '{"amount":4999,"currency":"USD"}'::jsonb, NULL,
  '{"amount":0,"currency":"USD","freeThreshold":null}'::jsonb,
  'new', '{"inStock":true,"quantity":100,"singleUnit":true}'::jsonb, NULL, '[]'::jsonb,
  '{"hero":{"avif":["http://127.0.0.1:4000/media/dummy/headphones.avif"],"webp":["http://127.0.0.1:4000/media/dummy/headphones.webp"],"width":1080,"height":1080,"blurhash":"LEHV6nWB2yk8pyo0adR*.7kCMdnj"},"gallery":[],"video":null}'::jsonb,
  '00000000-0000-4000-8000-000000000004', to_jsonb(array_fill(0.0::double precision, ARRAY[128])), 'dummy-v128',
  '{"score":0.9,"reviewAdj":0.9,"corpusDepth":0.8,"sentimentConsistency":0.9,"listingCompleteness":0.95,"engagement":0.5,"credibilityFactor":0.9,"cautions":[],"computedAt":"2026-01-01T00:00:00Z"}'::jsonb,
  '{"score":0.05,"tier":"clear","signals":[],"modelVersion":"dummy-v1","reports":{"count":0,"upheld":0},"reviewedBy":null,"reviewedAt":null,"computedAt":"2026-01-01T00:00:00Z"}'::jsonb,
  '{"impressions":0,"interactions":0,"ctrSmoothed":0,"cartAdds":0}'::jsonb,
  '{"firstSeenAt":"2026-01-01T00:00:00Z","lastCrawledAt":"2026-01-01T00:00:00Z","lastChangedAt":"2026-01-01T00:00:00Z","failCount":0,"tier":1}'::jsonb,
  'active', NULL, NOW(), NOW()
),
(
  '00000000-0000-4000-8000-000000000102', NULL,
  '{"domain":"example.com","sourceId":"window-dummy","tier":1,"url":"https://example.com/cable"}'::jsonb,
  'new', 'USB-C Charging Cable (2m)', 'USB-C Charging Cable (2m)', 'Window Demo', '{}'::jsonb,
  '{"l1":"tech","l2":"phones","l3":"phone-accessories"}'::jsonb,
  '{"amount":1299,"currency":"USD"}'::jsonb, NULL,
  '{"amount":0,"currency":"USD","freeThreshold":null}'::jsonb,
  'new', '{"inStock":true,"quantity":100,"singleUnit":true}'::jsonb, NULL, '[]'::jsonb,
  '{"hero":{"avif":["http://127.0.0.1:4000/media/dummy/cable.avif"],"webp":["http://127.0.0.1:4000/media/dummy/cable.webp"],"width":1080,"height":1080,"blurhash":"LEHV6nWB2yk8pyo0adR*.7kCMdnj"},"gallery":[],"video":null}'::jsonb,
  '00000000-0000-4000-8000-000000000004', to_jsonb(array_fill(0.0::double precision, ARRAY[128])), 'dummy-v128',
  '{"score":0.9,"reviewAdj":0.9,"corpusDepth":0.8,"sentimentConsistency":0.9,"listingCompleteness":0.95,"engagement":0.5,"credibilityFactor":0.9,"cautions":[],"computedAt":"2026-01-01T00:00:00Z"}'::jsonb,
  '{"score":0.05,"tier":"clear","signals":[],"modelVersion":"dummy-v1","reports":{"count":0,"upheld":0},"reviewedBy":null,"reviewedAt":null,"computedAt":"2026-01-01T00:00:00Z"}'::jsonb,
  '{"impressions":0,"interactions":0,"ctrSmoothed":0,"cartAdds":0}'::jsonb,
  '{"firstSeenAt":"2026-01-01T00:00:00Z","lastCrawledAt":"2026-01-01T00:00:00Z","lastChangedAt":"2026-01-01T00:00:00Z","failCount":0,"tier":1}'::jsonb,
  'active', NULL, NOW(), NOW()
),
(
  '00000000-0000-4000-8000-000000000103', NULL,
  '{"domain":"example.com","sourceId":"window-dummy","tier":1,"url":"https://example.com/powerbank"}'::jsonb,
  'new', 'Portable Power Bank 10000mAh', 'Portable Power Bank 10000mAh', 'Window Demo', '{}'::jsonb,
  '{"l1":"tech","l2":"phones","l3":"phone-accessories"}'::jsonb,
  '{"amount":2499,"currency":"USD"}'::jsonb, NULL,
  '{"amount":0,"currency":"USD","freeThreshold":null}'::jsonb,
  'new', '{"inStock":true,"quantity":100,"singleUnit":true}'::jsonb, NULL, '[]'::jsonb,
  '{"hero":{"avif":["http://127.0.0.1:4000/media/dummy/power-bank.avif"],"webp":["http://127.0.0.1:4000/media/dummy/power-bank.webp"],"width":1080,"height":1080,"blurhash":"LEHV6nWB2yk8pyo0adR*.7kCMdnj"},"gallery":[],"video":null}'::jsonb,
  '00000000-0000-4000-8000-000000000004', to_jsonb(array_fill(0.0::double precision, ARRAY[128])), 'dummy-v128',
  '{"score":0.9,"reviewAdj":0.9,"corpusDepth":0.8,"sentimentConsistency":0.9,"listingCompleteness":0.95,"engagement":0.5,"credibilityFactor":0.9,"cautions":[],"computedAt":"2026-01-01T00:00:00Z"}'::jsonb,
  '{"score":0.05,"tier":"clear","signals":[],"modelVersion":"dummy-v1","reports":{"count":0,"upheld":0},"reviewedBy":null,"reviewedAt":null,"computedAt":"2026-01-01T00:00:00Z"}'::jsonb,
  '{"impressions":0,"interactions":0,"ctrSmoothed":0,"cartAdds":0}'::jsonb,
  '{"firstSeenAt":"2026-01-01T00:00:00Z","lastCrawledAt":"2026-01-01T00:00:00Z","lastChangedAt":"2026-01-01T00:00:00Z","failCount":0,"tier":1}'::jsonb,
  'active', NULL, NOW(), NOW()
),
(
  '00000000-0000-4000-8000-000000000104', NULL,
  '{"domain":"example.com","sourceId":"window-dummy","tier":1,"url":"https://example.com/stand"}'::jsonb,
  'new', 'Adjustable Smartphone Stand', 'Adjustable Smartphone Stand', 'Window Demo', '{}'::jsonb,
  '{"l1":"tech","l2":"phones","l3":"phone-accessories"}'::jsonb,
  '{"amount":899,"currency":"USD"}'::jsonb, NULL,
  '{"amount":0,"currency":"USD","freeThreshold":null}'::jsonb,
  'new', '{"inStock":true,"quantity":100,"singleUnit":true}'::jsonb, NULL, '[]'::jsonb,
  '{"hero":{"avif":["http://127.0.0.1:4000/media/dummy/phone-stand.avif"],"webp":["http://127.0.0.1:4000/media/dummy/phone-stand.webp"],"width":1080,"height":1080,"blurhash":"LEHV6nWB2yk8pyo0adR*.7kCMdnj"},"gallery":[],"video":null}'::jsonb,
  '00000000-0000-4000-8000-000000000004', to_jsonb(array_fill(0.0::double precision, ARRAY[128])), 'dummy-v128',
  '{"score":0.9,"reviewAdj":0.9,"corpusDepth":0.8,"sentimentConsistency":0.9,"listingCompleteness":0.95,"engagement":0.5,"credibilityFactor":0.9,"cautions":[],"computedAt":"2026-01-01T00:00:00Z"}'::jsonb,
  '{"score":0.05,"tier":"clear","signals":[],"modelVersion":"dummy-v1","reports":{"count":0,"upheld":0},"reviewedBy":null,"reviewedAt":null,"computedAt":"2026-01-01T00:00:00Z"}'::jsonb,
  '{"impressions":0,"interactions":0,"ctrSmoothed":0,"cartAdds":0}'::jsonb,
  '{"firstSeenAt":"2026-01-01T00:00:00Z","lastCrawledAt":"2026-01-01T00:00:00Z","lastChangedAt":"2026-01-01T00:00:00Z","failCount":0,"tier":1}'::jsonb,
  'active', NULL, NOW(), NOW()
)
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  raw_title = EXCLUDED.raw_title,
  price = EXCLUDED.price,
  stock = EXCLUDED.stock,
  media = EXCLUDED.media,
  embedding = EXCLUDED.embedding,
  embedding_version = EXCLUDED.embedding_version,
  updated_at = NOW();
