// Supabase Edge Function: search-thoughts
// Hybrid search: combines meaning-based search (embeddings) with exact keyword
// search, checks chunks inside long captures, and fuses the rankings.
// If the embedding step fails, it falls back to keyword-only search.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return Array.isArray(data?.embedding) ? data.embedding : null
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    // Identify the caller from their own login token, never from the request body
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return jsonResponse({ ok: false, error: 'Not signed in' }, 401)

    const body = await req.json()
    const query = body?.query
    if (!query || typeof query !== 'string') {
      return jsonResponse({ ok: false, error: 'A query is required' }, 400)
    }

    // Accept "limit" or the older "matchCount". Default 20, max 50.
    const requested = Number(body?.limit ?? body?.matchCount)
    const limit = Math.min(Math.max(Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 20, 1), 50)

    // If this returns null, search still works using keywords only
    const queryEmbedding = await getEmbedding(query)

    const rpcArgs: Record<string, unknown> = {
      query_text: query,
      p_user_id: user.id,
      match_count: limit,
    }
    if (queryEmbedding) rpcArgs.query_embedding = queryEmbedding

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const { data, error } = await admin.rpc('search_thoughts', rpcArgs)

    if (error) throw error

    return jsonResponse({ ok: true, results: data ?? [], keyword_only: !queryEmbedding })
  } catch (err) {
    console.error('search-thoughts error:', String(err))
    return jsonResponse({ ok: false, error: String(err) }, 500)
  }
})