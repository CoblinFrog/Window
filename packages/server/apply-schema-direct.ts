import { createClient } from '@supabase/supabase-js';
import { SUPABASE_CONFIG } from './src/config/supabase.js';

const client = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.serviceRoleKey);

async function applySchemaDirectly() {
  console.log('Applying checkout schema directly...');
  
  // Direct SQL queries through Postgres connection
  const postgresUrl = `${SUPABASE_CONFIG.url}/rest/v1/`;
  
  // We'll use the Supabase SQL editor approach by making direct calls
  // First, let's check what columns exist
  const { data: existingUsers, error: usersError } = await client
    .from('users')
    .select('*')
    .limit(1);
  
  if (usersError) {
    console.error('Error checking users table:', usersError);
  } else {
    console.log('Current users table structure:', Object.keys(existingUsers?.[0] || {}));
  }
  
  // Since we can't execute arbitrary SQL through the JS client easily,
  // let's guide the user to apply the schema manually
  console.log('\n=== MANUAL SCHEMA APPLICATION REQUIRED ===');
  console.log('Please run the following SQL in your Supabase SQL Editor:');
  console.log(`
-- Add checkout-specific fields to existing tables

-- Add device_secret_hash to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_secret_hash text UNIQUE;

-- Add session_epoch to users table  
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_epoch int not null default 1;

-- Add checkout column to sources table
ALTER TABLE sources ADD COLUMN IF NOT EXISTS checkout jsonb not null default '{"protocol":null,"blocksAgents":false,"stackableCoupons":false}';

-- Add submission_seq to orders table
ALTER TABLE orders ADD COLUMN IF NOT EXISTS submission_seq int not null default 0;

-- Create partial unique index for one open cart per user
CREATE UNIQUE INDEX IF NOT EXISTS carts_one_open_per_user ON carts (user_id) WHERE status = 'open';

-- Create unique index on auth email
CREATE UNIQUE INDEX IF NOT EXISTS users_auth_email ON users ((auth->>'email')) where auth->>'email' is not null;

-- Create index for orders by user
CREATE INDEX IF NOT EXISTS orders_by_user ON orders (user_id, created_at desc);

-- Enable RLS
ALTER TABLE users enable row level security;
ALTER TABLE carts enable row level security;
ALTER TABLE orders enable row level security;

-- Create RLS policies
CREATE POLICY IF NOT EXISTS "Users can view own data" ON users FOR select USING (auth.uid()::text = id::text);
CREATE POLICY IF NOT EXISTS "Users can insert own data" ON users FOR insert WITH CHECK (auth.uid()::text = id::text);
CREATE POLICY IF NOT EXISTS "Users can update own data" ON users FOR update USING (auth.uid()::text = id::text);

CREATE POLICY IF NOT EXISTS "Users can view own carts" ON carts FOR select USING (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS "Users can insert own carts" ON carts FOR insert WITH CHECK (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS "Users can update own carts" ON carts FOR update USING (auth.uid()::text = user_id::text);

CREATE POLICY IF NOT EXISTS "Users can view own orders" ON orders FOR select USING (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS "Users can insert own orders" ON orders FOR insert WITH CHECK (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS "Users can update own orders" ON orders FOR update USING (auth.uid()::text = user_id::text);
  `);
  
  console.log('\nAfter applying the SQL, run the tests again.');
}

applySchemaDirectly().catch(console.error);
