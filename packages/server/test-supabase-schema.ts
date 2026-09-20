import { createClient } from '@supabase/supabase-js';

const url = 'https://tusnxlijttcsukllcwcx.supabase.co';
const key = 'sb_secret_WeoYeab4Fv81GSi9sZ1_Ag_7qwW3df1';

const client = createClient(url, key);

async function checkSchema() {
  console.log('Checking schema in Supabase...');
  console.log('URL:', url);
  
  // Check if users table exists
  const { data: usersData, error: usersError } = await client
    .from('users')
    .select('*')
    .limit(1);
  
  if (usersError) {
    console.error('Users table error:', usersError);
  } else {
    console.log('✅ Users table exists');
  }
  
  // Check if carts table exists
  const { data: cartsData, error: cartsError } = await client
    .from('carts')
    .select('*')
    .limit(1);
  
  if (cartsError) {
    console.error('Carts table error:', cartsError);
  } else {
    console.log('✅ Carts table exists');
  }
  
  // Check if orders table exists
  const { data: ordersData, error: ordersError } = await client
    .from('orders')
    .select('*')
    .limit(1);
  
  if (ordersError) {
    console.error('Orders table error:', ordersError);
  } else {
    console.log('✅ Orders table exists');
  }

  // Check if sources table exists
  const { data: sourcesData, error: sourcesError } = await client
    .from('sources')
    .select('*')
    .limit(1);
  
  if (sourcesError) {
    console.error('Sources table error:', sourcesError);
  } else {
    console.log('✅ Sources table exists');
  }

  // Check if coupons table exists
  const { data: couponsData, error: couponsError } = await client
    .from('coupons')
    .select('*')
    .limit(1);
  
  if (couponsError) {
    console.error('Coupons table error:', couponsError);
  } else {
    console.log('✅ Coupons table exists');
  }

  // Check if merchant_links table exists
  const { data: linksData, error: linksError } = await client
    .from('merchant_links')
    .select('*')
    .limit(1);
  
  if (linksError) {
    console.error('Merchant links table error:', linksError);
  } else {
    console.log('✅ Merchant links table exists');
  }

  // Check if products table exists
  const { data: productsData, error: productsError } = await client
    .from('products')
    .select('*')
    .limit(1);
  
  if (productsError) {
    console.error('Products table error:', productsError);
  } else {
    console.log('✅ Products table exists');
  }
  
  console.log('Schema verification complete!');
}

checkSchema().catch(console.error);
