import { createClient } from '@supabase/supabase-js';
import { SUPABASE_CONFIG } from './src/config/supabase.js';
const c = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.serviceRoleKey);
for (const t of ['products','sellers','users','carts','orders','categories']) {
  const { count, error } = await c.from(t).select('*', { count: 'exact', head: true });
  console.log(t.padEnd(12), error ? 'ERR '+error.message : count);
}
