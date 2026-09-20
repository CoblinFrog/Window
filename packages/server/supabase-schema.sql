-- Window Supabase Schema
-- Migrated from MongoDB collections

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug TEXT NOT NULL UNIQUE,
  level INTEGER NOT NULL CHECK (level IN (1, 2, 3)),
  parent_id TEXT,
  l1 TEXT NOT NULL,
  display_name TEXT NOT NULL,
  centroid JSONB,
  centroid_computed_at TIMESTAMP WITH TIME ZONE,
  member_count INTEGER DEFAULT 0,
  tile JSONB,
  engagement JSONB NOT NULL DEFAULT '{"medianCtr": 0, "productCount": 0}'::jsonb,
  co_occurrence JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_categories_slug ON categories(slug);
CREATE INDEX idx_categories_level ON categories(level);
CREATE INDEX idx_categories_parent ON categories(parent_id);

-- ---------------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------------
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cluster_id UUID,
  source JSONB NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('new', 'secondhand', 'auction')),
  title TEXT NOT NULL,
  raw_title TEXT NOT NULL,
  brand TEXT,
  identifiers JSONB DEFAULT '{}'::jsonb,
  category JSONB NOT NULL,
  price JSONB NOT NULL,
  original_price JSONB,
  shipping JSONB NOT NULL,
  condition TEXT NOT NULL CHECK (condition IN ('new', 'like_new', 'excellent', 'good', 'fair', 'poor', 'for_parts', 'unknown')),
  stock JSONB NOT NULL,
  auction JSONB,
  specs JSONB DEFAULT '[]'::jsonb,
  media JSONB NOT NULL,
  seller_id UUID NOT NULL,
  embedding JSONB NOT NULL,
  embedding_version TEXT NOT NULL,
  quality JSONB NOT NULL,
  risk JSONB NOT NULL,
  engagement JSONB NOT NULL DEFAULT '{"impressions": 0, "interactions": 0, "ctrSmoothed": 0, "cartAdds": 0}'::jsonb,
  crawl JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'stale', 'dead', 'rejected')),
  reject_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_products_cluster_id ON products(cluster_id);
CREATE INDEX idx_products_seller_id ON products(seller_id);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_source_type ON products(source_type);
CREATE INDEX idx_products_brand ON products(brand);
CREATE INDEX idx_products_condition ON products(condition);
CREATE INDEX idx_products_title ON products USING gin(to_tsvector('english', title));

-- ---------------------------------------------------------------------------
-- Product Clusters
-- ---------------------------------------------------------------------------
CREATE TABLE product_clusters (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  canonical_product_id UUID NOT NULL,
  title TEXT NOT NULL,
  brand TEXT,
  category JSONB NOT NULL,
  identifiers JSONB DEFAULT '{}'::jsonb,
  offer_count INTEGER DEFAULT 0,
  price_range JSONB NOT NULL,
  source_types JSONB DEFAULT '[]'::jsonb,
  embedding JSONB NOT NULL,
  reviews JSONB NOT NULL,
  engagement JSONB NOT NULL DEFAULT '{"impressions": 0, "ctrSmoothed": 0, "upvotes": 0}'::jsonb,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_clusters_canonical ON product_clusters(canonical_product_id);
CREATE INDEX idx_clusters_brand ON product_clusters(brand);

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_user_id TEXT NOT NULL UNIQUE,
  auth JSONB,
  onboarding JSONB,
  interest_vector JSONB,
  interest_set JSONB DEFAULT '[]'::jsonb,
  exploration_state JSONB NOT NULL,
  price_prior JSONB NOT NULL,
  affinities JSONB NOT NULL DEFAULT '{"brands": {}, "sellers": {}}'::jsonb,
  suppressions JSONB NOT NULL DEFAULT '{"products": [], "brands": [], "sellers": []}'::jsonb,
  seen_filter JSONB NOT NULL,
  counters JSONB NOT NULL,
  settings JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_users_device_id ON users(device_user_id);
CREATE INDEX idx_users_auth_email ON users((auth->>'email'));

-- ---------------------------------------------------------------------------
-- Interactions
-- ---------------------------------------------------------------------------
CREATE TABLE interactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  product_id UUID NOT NULL,
  cluster_id UUID,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('impression', 'dwell_short', 'dwell_long', 'skip_fast', 'gallery_advance', 'upvote', 'upvote_removed', 'reviews_open', 'reviews_dwell', 'seller_open', 'share', 'cart_add', 'cart_remove', 'purchase', 'hide_product', 'hide_brand', 'mute_seller')),
  weight NUMERIC NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('single', 'window')),
  position INTEGER NOT NULL,
  dwell_ms INTEGER,
  is_exploration BOOLEAN NOT NULL DEFAULT false,
  category JSONB NOT NULL,
  reason TEXT CHECK (reason IN ('price', 'design', 'brand', 'need_it')),
  ranking_config_version TEXT NOT NULL,
  experiments JSONB DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL,
  client_ts TIMESTAMP WITH TIME ZONE NOT NULL,
  server_ts TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_interactions_user_id ON interactions(user_id);
CREATE INDEX idx_interactions_product_id ON interactions(product_id);
CREATE INDEX idx_interactions_cluster_id ON interactions(cluster_id);
CREATE INDEX idx_interactions_session_id ON interactions(session_id);
CREATE INDEX idx_interactions_type ON interactions(type);
CREATE INDEX idx_interactions_server_ts ON interactions(server_ts);
CREATE INDEX idx_interactions_idempotency ON interactions(idempotency_key);

-- ---------------------------------------------------------------------------
-- Sellers
-- ---------------------------------------------------------------------------
CREATE TABLE sellers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_domain TEXT NOT NULL,
  source_seller_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('retailer', 'individual', 'auction_house')),
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  profile_url TEXT NOT NULL,
  metrics JSONB NOT NULL,
  policies JSONB,
  auction_terms JSONB,
  live_listing_count INTEGER DEFAULT 0,
  trust JSONB NOT NULL,
  suppressed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_sellers_source_domain ON sellers(source_domain);
CREATE INDEX idx_sellers_source_seller_id ON sellers(source_seller_id);
CREATE INDEX idx_sellers_handle ON sellers(handle);
CREATE INDEX idx_sellers_suppressed ON sellers(suppressed);

-- ---------------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------------
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cluster_id UUID NOT NULL,
  source JSONB NOT NULL,
  rating NUMERIC NOT NULL,
  rating_scale INTEGER NOT NULL,
  excerpt TEXT NOT NULL,
  author_handle TEXT,
  verified_purchase BOOLEAN,
  helpful_count INTEGER DEFAULT 0,
  posted_at TIMESTAMP WITH TIME ZONE NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('recent', 'helpful', 'critical', 'positive')),
  themes JSONB DEFAULT '[]'::jsonb,
  fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_reviews_cluster_id ON reviews(cluster_id);
CREATE INDEX idx_reviews_posted_at ON reviews(posted_at);
CREATE INDEX idx_reviews_rating ON reviews(rating);

-- ---------------------------------------------------------------------------
-- Carts
-- ---------------------------------------------------------------------------
CREATE TABLE carts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'checking_out', 'closed')),
  items JSONB DEFAULT '[]'::jsonb,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_carts_user_id ON carts(user_id);
CREATE INDEX idx_carts_status ON carts(status);

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  cart_id UUID NOT NULL,
  merchant_domain TEXT NOT NULL,
  items JSONB NOT NULL,
  quote JSONB,
  coupon JSONB,
  "authorization" JSONB,
  payment JSONB,
  agent_run JSONB,
  status TEXT NOT NULL CHECK (status IN ('pending', 'quoting', 'awaiting_auth', 'placing', 'placed', 'uncertain', 'failed', 'cancelled')),
  merchant_order_number TEXT,
  failure JSONB,
  submission_seq INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_cart_id ON orders(cart_id);
CREATE INDEX idx_orders_merchant_domain ON orders(merchant_domain);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);

-- ---------------------------------------------------------------------------
-- Coupons
-- ---------------------------------------------------------------------------
CREATE TABLE coupons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_domain TEXT NOT NULL,
  code TEXT NOT NULL,
  discovered JSONB NOT NULL,
  constraints JSONB NOT NULL,
  performance JSONB NOT NULL,
  stackable BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_coupons_merchant_domain ON coupons(merchant_domain);
CREATE INDEX idx_coupons_code ON coupons(code);
CREATE INDEX idx_coupons_status ON coupons(status);

-- ---------------------------------------------------------------------------
-- Sources
-- ---------------------------------------------------------------------------
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK (tier IN (1, 2, 3)),
  source_type TEXT NOT NULL CHECK (source_type IN ('new', 'secondhand', 'auction')),
  crawl_policy JSONB NOT NULL,
  staleness_ceiling_hours INTEGER NOT NULL,
  extractors JSONB NOT NULL,
  health JSONB NOT NULL,
  checkout JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'degraded', 'blocked')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_sources_tier ON sources(tier);
CREATE INDEX idx_sources_status ON sources(status);

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------
CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id UUID NOT NULL,
  seller_id UUID NOT NULL,
  user_id UUID NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('counterfeit', 'not_as_described', 'seller_unresponsive', 'price_manipulation', 'stolen_photos')),
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'upheld', 'dismissed')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  resolved_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_reports_product_id ON reports(product_id);
CREATE INDEX idx_reports_seller_id ON reports(seller_id);
CREATE INDEX idx_reports_user_id ON reports(user_id);
CREATE INDEX idx_reports_status ON reports(status);

-- ---------------------------------------------------------------------------
-- Merchant Links
-- ---------------------------------------------------------------------------
CREATE TABLE merchant_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  merchant_domain TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'linked', 'expired', 'revoked')),
  encrypted_session JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  linked_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX idx_merchant_links_user_id ON merchant_links(user_id);
CREATE INDEX idx_merchant_links_merchant_domain ON merchant_links(merchant_domain);
CREATE INDEX idx_merchant_links_status ON merchant_links(status);

-- ---------------------------------------------------------------------------
-- Foreign Key Constraints
-- ---------------------------------------------------------------------------
ALTER TABLE products ADD CONSTRAINT fk_products_cluster FOREIGN KEY (cluster_id) REFERENCES product_clusters(id) ON DELETE SET NULL;
ALTER TABLE products ADD CONSTRAINT fk_products_seller FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE RESTRICT;
ALTER TABLE product_clusters ADD CONSTRAINT fk_clusters_canonical FOREIGN KEY (canonical_product_id) REFERENCES products(id) ON DELETE RESTRICT;
ALTER TABLE interactions ADD CONSTRAINT fk_interactions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE interactions ADD CONSTRAINT fk_interactions_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE interactions ADD CONSTRAINT fk_interactions_cluster FOREIGN KEY (cluster_id) REFERENCES product_clusters(id) ON DELETE SET NULL;
ALTER TABLE reviews ADD CONSTRAINT fk_reviews_cluster FOREIGN KEY (cluster_id) REFERENCES product_clusters(id) ON DELETE CASCADE;
ALTER TABLE carts ADD CONSTRAINT fk_carts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE orders ADD CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE orders ADD CONSTRAINT fk_orders_cart FOREIGN KEY (cart_id) REFERENCES carts(id) ON DELETE RESTRICT;
ALTER TABLE reports ADD CONSTRAINT fk_reports_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE reports ADD CONSTRAINT fk_reports_seller FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE;
ALTER TABLE reports ADD CONSTRAINT fk_reports_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE merchant_links ADD CONSTRAINT fk_merchant_links_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Update Timestamp Trigger Function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
CREATE TRIGGER update_categories_updated_at BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_clusters_updated_at BEFORE UPDATE ON product_clusters FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_sellers_updated_at BEFORE UPDATE ON sellers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_carts_updated_at BEFORE UPDATE ON carts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_coupons_updated_at BEFORE UPDATE ON coupons FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_sources_updated_at BEFORE UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();