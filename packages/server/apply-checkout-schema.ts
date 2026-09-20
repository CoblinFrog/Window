import { createClient } from '@supabase/supabase-js';
import { SUPABASE_CONFIG } from './src/config/supabase.js';

const client = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.serviceRoleKey);

async function applyCheckoutSchema() {
  console.log('Applying checkout schema to remote database...');
  
  // Add device_secret_hash to users table
  try {
    const { error: secretHashError } = await client.rpc('exec_sql', {
      sql: `
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'device_secret_hash'
          ) THEN
            ALTER TABLE users ADD COLUMN device_secret_hash text UNIQUE;
          END IF;
        END $$;
      `
    });
    
    if (secretHashError) {
      console.error('Error adding device_secret_hash:', secretHashError);
    } else {
      console.log('✅ Added device_secret_hash column');
    }
  } catch (e) {
    console.error('Exception adding device_secret_hash:', e);
  }
  
  // Add session_epoch to users table
  try {
    const { error: sessionEpochError } = await client.rpc('exec_sql', {
      sql: `
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'session_epoch'
          ) THEN
            ALTER TABLE users ADD COLUMN session_epoch int not null default 1;
          END IF;
        END $$;
      `
    });
    
    if (sessionEpochError) {
      console.error('Error adding session_epoch:', sessionEpochError);
    } else {
      console.log('✅ Added session_epoch column');
    }
  } catch (e) {
    console.error('Exception adding session_epoch:', e);
  }
  
  // Add checkout column to sources table
  try {
    const { error: checkoutError } = await client.rpc('exec_sql', {
      sql: `
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'sources' AND column_name = 'checkout'
          ) THEN
            ALTER TABLE sources ADD COLUMN checkout jsonb not null default '{"protocol":null,"blocksAgents":false,"stackableCoupons":false}';
          END IF;
        END $$;
      `
    });
    
    if (checkoutError) {
      console.error('Error adding checkout column:', checkoutError);
    } else {
      console.log('✅ Added checkout column to sources');
    }
  } catch (e) {
    console.error('Exception adding checkout column:', e);
  }
  
  // Add submission_seq to orders table
  try {
    const { error: submissionSeqError } = await client.rpc('exec_sql', {
      sql: `
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'orders' AND column_name = 'submission_seq'
          ) THEN
            ALTER TABLE orders ADD COLUMN submission_seq int not null default 0;
          END IF;
        END $$;
      `
    });
    
    if (submissionSeqError) {
      console.error('Error adding submission_seq:', submissionSeqError);
    } else {
      console.log('✅ Added submission_seq column to orders');
    }
  } catch (e) {
    console.error('Exception adding submission_seq:', e);
  }
  
  // Create partial unique index for carts
  try {
    const { error: cartIndexError } = await client.rpc('exec_sql', {
      sql: `
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_indexes 
            WHERE indexname = 'carts_one_open_per_user'
          ) THEN
            CREATE UNIQUE INDEX carts_one_open_per_user ON carts (user_id) WHERE status = 'open';
          END IF;
        END $$;
      `
    });
    
    if (cartIndexError) {
      console.error('Error creating cart index:', cartIndexError);
    } else {
      console.log('✅ Created carts_one_open_per_user index');
    }
  } catch (e) {
    console.error('Exception creating cart index:', e);
  }
  
  // Create unique index on auth email
  try {
    const { error: emailIndexError } = await client.rpc('exec_sql', {
      sql: `
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_indexes 
            WHERE indexname = 'users_auth_email'
          ) THEN
            CREATE UNIQUE INDEX users_auth_email ON users ((auth->>'email')) where auth->>'email' is not null;
          END IF;
        END $$;
      `
    });
    
    if (emailIndexError) {
      console.error('Error creating email index:', emailIndexError);
    } else {
      console.log('✅ Created users_auth_email index');
    }
  } catch (e) {
    console.error('Exception creating email index:', e);
  }
  
  console.log('Schema application complete!');
}

applyCheckoutSchema().catch(console.error);
