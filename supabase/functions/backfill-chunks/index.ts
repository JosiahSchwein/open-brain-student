// Supabase Edge Function: backfill-chunks
// One-time catch-up: chunks every existing thought long enough to need it but
// that doesn't have chunks yet (see the thoughts_needing_chunks view).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { saveThoughtChunksSafe } from '../_shared/thought-chunks.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

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
    const dryRun = body.dry_run === true

    if (dryRun) {
      const needing = await dbFetch(`thoughts_needing_chunks?select=id`)
      return new Response(JSON.stringify({ needs_chunks: Array.isArray(needing) ? needing.length : 0 }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Biggest documents first — they matter most if this run gets interrupted.
    const batch = await dbFetch(`thoughts_needing_chunks?order=chars.desc&limit=${batchSize}`)

    let chunked = 0
    for (const row of batch) {
      try {
        const [full] = await dbFetch(`thoughts?id=eq.${row.id}&select=content`)
        if (!full?.content) continue
        const count = await saveThoughtChunksSafe(supabase, row.id, full.content, 'backfill-chunks', 'summary')
        if (count > 0) chunked++
      } catch (err) {
        console.error(`backfill-chunks: failed for thought ${row.id}:`, String(err))
      }
    }

    const remainingRows = await dbFetch(`thoughts_needing_chunks?select=id`)
    const remaining = Array.isArray(remainingRows) ? remainingRows.length : 0

    return new Response(JSON.stringify({
      processed: batch.length,
      chunked,
      remaining,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('backfill-chunks error:', String(err))
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
