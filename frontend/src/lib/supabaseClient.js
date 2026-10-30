import { createClient } from '@supabase/supabase-js';
import { OPERATIONS_RUNTIME } from '../config/operationsRuntime.js';

let singleton = null;

export function createSupabaseBrowserClient(runtime = OPERATIONS_RUNTIME) {
  if (!runtime?.supabaseUrl || !runtime?.supabaseAnonKey) {
    return null;
  }

  return createClient(runtime.supabaseUrl, runtime.supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    db: {
      schema: 'public',
    },
    global: {
      headers: {
        'x-application-name': 'smart-account-frontend',
      },
    },
  });
}

export function getSupabaseClient(runtime = OPERATIONS_RUNTIME) {
  if (!singleton) {
    singleton = createSupabaseBrowserClient(runtime);
  }
  return singleton;
}

export function resetSupabaseClientForTests() {
  singleton = null;
}
