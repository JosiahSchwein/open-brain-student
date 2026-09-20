// Supabase Edge Function: backfill-embeddings
// One-time catch-up: generates embeddings for thoughts that don't have one
// yet, in small batches (to stay under rate limits and function time limits).

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
    const batchSize = Number(body.batch_size) > 0 ? Number(body.batch_size) : 5
    const offset = Number(body.offset) >= 0 ? Number(body.offset) : 0

    const batch = await dbFetch(
      `thoughts?embedding=is.null&order=created_at.asc&limit=${batchSize}&select=id,content`
    )

    let embedded = 0
    let failed = 0

    for (const thought of batch) {
      try {
        const embResponse = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE_KEY}` },
          body: JSON.stringify({ text: thought.content }),
        })
        const embData = await embResponse.json()
        const embedding = embData?.embedding

        if (embedding) {
          await dbFetch(`thoughts?id=eq.${thought.id}`, {
            method: 'PATCH',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({ embedding }),
          })
          embedded++
        } else {
          failed++
        }
      } catch (err) {
        console.error(`backfill-embeddings: failed for thought ${thought.id}:`, String(err))
        failed++
      }
    }

    const remainingRows = await dbFetch(`thoughts?embedding=is.null&select=id`)
    const remaining = Array.isArray(remainingRows) ? remainingRows.length : 0

    return new Response(JSON.stringify({
      processed: batch.length,
      embedded,
      failed,
      offset_next: offset + batch.length,
      remaining,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('backfill-embeddings error:', String(err))
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
