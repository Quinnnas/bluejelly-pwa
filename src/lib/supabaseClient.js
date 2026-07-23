import { createClient } from "@supabase/supabase-js";

// These come from your .env file (see .env.example) and, for the live
// deployment, from Vercel's Environment Variables settings — never commit
// real values to a file that gets pushed to GitHub.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Loud, obvious failure in dev rather than a silent broken app.
  console.error(
    "Missing Supabase config. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY " +
    "in your .env file (see .env.example) or in Vercel's Environment Variables."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
