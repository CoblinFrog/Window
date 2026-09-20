-- Add checkout-specific fields to existing tables
-- This migration adapts the existing MongoDB-migrated schema for checkout

-- Add device_secret_hash to users table if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'device_secret_hash'
  ) THEN
    ALTER TABLE users ADD COLUMN device_secret_hash text UNIQUE;
  END IF;
END $$;

-- Add session_epoch to users table if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'session_epoch'
  ) THEN
    ALTER TABLE users ADD COLUMN session_epoch int not null default 1;
  END IF;
END $$;

-- Add checkout column to sources table if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'sources' AND column_name = 'checkout'
  ) THEN
    ALTER TABLE sources ADD COLUMN checkout jsonb not null default '{"protocol":null,"blocksAgents":false,"stackableCoupons":false}';
  END IF;
END $$;

-- Add submission_seq to orders table if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'orders' AND column_name = 'submission_seq'
  ) THEN
    ALTER TABLE orders ADD COLUMN submission_seq int not null default 0;
  END IF;
END $$;

-- Make cart_id nullable in orders table if it's currently NOT NULL
DO $$
BEGIN
  -- Check if cart_id is currently NOT NULL
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'orders' AND column_name = 'cart_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE orders ALTER COLUMN cart_id DROP NOT NULL;
  END IF;
END $$;

-- Create partial unique index for one open cart per user if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE indexname = 'carts_one_open_per_user'
  ) THEN
    CREATE UNIQUE INDEX carts_one_open_per_user ON carts (user_id) WHERE status = 'open';
  END IF;
END $$;

-- Create unique index on auth email if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE indexname = 'users_auth_email'
  ) THEN
    CREATE UNIQUE INDEX users_auth_email ON users ((auth->>'email')) where auth->>'email' is not null;
  END IF;
END $$;

-- Create index for orders by user if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE indexname = 'orders_by_user'
  ) THEN
    CREATE INDEX orders_by_user ON orders (user_id, created_at desc);
  END IF;
END $$;

-- Enable RLS if not already enabled
ALTER TABLE users enable row level security;
ALTER TABLE carts enable row level security;
ALTER TABLE orders enable row level security;

-- Create RLS policies if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE policyname = 'Users can view own data'
  ) THEN
    CREATE POLICY "Users can view own data" ON users FOR select USING (auth.uid()::text = id::text);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE policyname = 'Users can insert own data'
  ) THEN
    CREATE POLICY "Users can insert own data" ON users FOR insert WITH CHECK (auth.uid()::text = id::text);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE policyname = 'Users can update own data'
  ) THEN
    CREATE POLICY "Users can update own data" ON users FOR update USING (auth.uid()::text = id::text);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE policyname = 'Users can view own carts'
  ) THEN
    CREATE POLICY "Users can view own carts" ON carts FOR select USING (auth.uid()::text = user_id::text);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE policyname = 'Users can insert own carts'
  ) THEN
    CREATE POLICY "Users can insert own carts" ON carts FOR insert WITH CHECK (auth.uid()::text = user_id::text);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE policyname = 'Users can update own carts'
  ) THEN
    CREATE POLICY "Users can update own carts" ON carts FOR update USING (auth.uid()::text = user_id::text);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE policyname = 'Users can view own orders'
  ) THEN
    CREATE POLICY "Users can view own orders" ON orders FOR select USING (auth.uid()::text = user_id::text);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE policyname = 'Users can insert own orders'
  ) THEN
    CREATE POLICY "Users can insert own orders" ON orders FOR insert WITH CHECK (auth.uid()::text = user_id::text);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE policyname = 'Users can update own orders'
  ) THEN
    CREATE POLICY "Users can update own orders" ON orders FOR update USING (auth.uid()::text = user_id::text);
  END IF;
END $$;
