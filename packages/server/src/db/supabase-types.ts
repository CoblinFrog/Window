/**
 * Basic Supabase database types.
 * For full type safety, run: supabase gen types typescript --local > src/db/supabase-types.ts
 */
export interface Database {
  public: {
    Tables: {
      categories: {
        Row: any;
        Insert: any;
        Update: any;
      };
      products: {
        Row: any;
        Insert: any;
        Update: any;
      };
      product_clusters: {
        Row: any;
        Insert: any;
        Update: any;
      };
      users: {
        Row: any;
        Insert: any;
        Update: any;
      };
      interactions: {
        Row: any;
        Insert: any;
        Update: any;
      };
      sellers: {
        Row: any;
        Insert: any;
        Update: any;
      };
      reviews: {
        Row: any;
        Insert: any;
        Update: any;
      };
      carts: {
        Row: any;
        Insert: any;
        Update: any;
      };
      orders: {
        Row: any;
        Insert: any;
        Update: any;
      };
      coupons: {
        Row: any;
        Insert: any;
        Update: any;
      };
      sources: {
        Row: any;
        Insert: any;
        Update: any;
      };
      reports: {
        Row: any;
        Insert: any;
        Update: any;
      };
      merchant_links: {
        Row: any;
        Insert: any;
        Update: any;
      };
    };
  };
}