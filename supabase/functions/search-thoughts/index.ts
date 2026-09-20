// Supabase Edge Function: search-thoughts
// Semantic search: embeds the query, then finds thoughts whose embeddings
// are closest in meaning — not closest in literal wording.

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return jsonResponse({ ok: false, error: 'Not signed in' }, 401)

    const { query, matchCount } = await req.json()
    if (!query || typeof query !== 'string') {
      return jsonResponse({ ok: false, error: 'A query is required' }, 400)
    }

    const embResponse = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ text: query }),
    })
    const embData = await embResponse.json()
    const queryEmbedding = embData?.embedding

    if (!queryEmbedding) {
      return jsonResponse({ ok: false, error: 'Could not generate a search embedding right now. Try again shortly.' }, 502)
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const { data, error } = await admin.rpc('match_thoughts', {
      query_embedding: queryEmbedding,
      match_user_id: user.id,
      match_count: matchCount || 10,
    })

    if (error) throw error

    return jsonResponse({ ok: true, results: data ?? [] })
  } catch (err) {
    console.error('search-thoughts error:', String(err))
    return jsonResponse({ ok: false, error: String(err) }, 500)
  }
})
