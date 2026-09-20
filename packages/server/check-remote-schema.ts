import { createClient } from '@supabase/supabase-js';
import { SUPABASE_CONFIG } from './src/config/supabase.js';

const client = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.serviceRoleKey);

async function checkRemoteSchema() {
  console.log('Checking remote database schema...');
  console.log('URL:', SUPABASE_CONFIG.url);
  
  // Get table information
  const { data: tables, error: tablesError } = await client
    .rpc('get_tables', { schema_name: 'public' });
  
  if (tablesError) {
    console.error('Error getting tables:', tablesError);
    
    // Try alternative approach - query information_schema
    const { data: schemaData, error: schemaError } = await client
      .from('information_schema.tables')
      .select('table_name')
      .eq('table_schema', 'public');
    
    if (schemaError) {
      console.error('Error querying information_schema:', schemaError);
    } else {
      console.log('Tables in public schema:', schemaData);
    }
  } else {
    console.log('Tables:', tables);
  }
  
  // Check users table structure
  const { data: usersColumns, error: usersError } = await client
    .from('users')
    .select('*')
    .limit(1);
  
  if (usersError) {
    console.error('Users table error:', usersError);
  } else {
    console.log('Users table exists, sample data:', usersColumns);
  }
  
  // Check sources table structure
  const { data: sourcesColumns, error: sourcesError } = await client
    .from('sources')
    .select('*')
    .limit(1);
  
  if (sourcesError) {
    console.error('Sources table error:', sourcesError);
  } else {
    console.log('Sources table exists, sample data:', sourcesColumns);
  }
}

checkRemoteSchema().catch(console.error);
