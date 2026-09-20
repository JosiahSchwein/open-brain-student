// Supabase Edge Function: backfill-links
// One-time catch-up: runs link_related_thoughts for every thought that
// already has an embedding but hasn't been linked yet.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function dbFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...(options.headers || {}),
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`DB request failed: ${res.status} ${text}`)
  }
  return res.json()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const body = await req.json().catch(() => ({}))
    const batchSize = Number(body.batch_size) > 0 ? Number(body.batch_size) : 10

    const candidates = await dbFetch(
      `thoughts?embedding=not.is.null&select=id,user_id,embedding&order=created_at.asc&limit=${batchSize}`
    )

    let linked = 0
    let failed = 0

    for (const thought of candidates) {
      try {
        const existing = await dbFetch(`thought_links?thought_id=eq.${thought.id}&select=id&limit=1`)
        if (Array.isArray(existing) && existing.length > 0) continue

        const linkRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/link_related_thoughts`, {
          method: 'POST',
          headers: {
            'apikey': SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            p_thought_id: thought.id,
            p_user_id: thought.user_id,
            p_embedding: thought.embedding,
          }),
        })
        if (linkRes.ok) linked++
        else failed++
      } catch (err) {
        console.error(`backfill-links: failed for thought ${thought.id}:`, String(err))
        failed++
      }
    }

    return new Response(JSON.stringify({
      processed: candidates.length,
      linked,
      failed,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('backfill-links error:', String(err))
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
