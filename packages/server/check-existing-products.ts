import { createClient } from '@supabase/supabase-js';
import { SUPABASE_CONFIG } from './src/config/supabase.js';

const client = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.serviceRoleKey);

async function checkExistingProducts() {
  console.log('Checking existing products in Supabase...');

  const { data, error } = await client
    .from('products')
    .select('id, title, price, status')
    .limit(10);

  if (error) {
    console.error('Error fetching products:', error);
  } else if (data && data.length > 0) {
    console.log(`Found ${data.length} existing products:`);
    data.forEach((product) => {
      console.log(`- ${product.title} (${product.id}) - $${product.price?.amount / 100}`);
    });
    
    // Get the first few product IDs for testing
    const productIds = data.slice(0, 4).map((p) => p.id);
    console.log('\nProduct IDs for testing:', productIds);
  } else {
    console.log('No existing products found');
  }
}

checkExistingProducts().catch(console.error);
