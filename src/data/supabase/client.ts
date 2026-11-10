import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/** Клиент Supabase из переменных окружения сборки. Ключ только публичный (anon); service_role в клиент не кладётся. */
export function createSupabaseClient(url = import.meta.env.VITE_SUPABASE_URL, anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY): SupabaseClient {
  if (!url || !anonKey) {
    throw new Error('CONFIG: не заданы VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY')
  }
  return createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })
}

export const isSupabaseConfigured = (): boolean =>
  Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)
