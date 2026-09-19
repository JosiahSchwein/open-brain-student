// Supabase Edge Function: weekly-digest
// Meant to be called by pg_cron on a schedule. Reads the last 7 days of
// thoughts, asks the LLM gateway for a summary, and saves that as a new
// thought with category 'digest'.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID')!

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
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const thoughts = await dbFetch(
      `thoughts?user_id=eq.${OWNER_USER_ID}&created_at=gte.${sevenDaysAgo}&category=neq.digest&order=created_at.asc&limit=200`
    )

    if (!Array.isArray(thoughts) || thoughts.length < 5) {
      console.log(`weekly-digest: only ${thoughts?.length ?? 0} thoughts in the last 7 days, skipping (need at least 5)`)
      return new Response(JSON.stringify({ ok: true, skipped: true, count: thoughts?.length ?? 0 }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const byCategory: Record<string, string[]> = {}
    for (const t of thoughts) {
      const cat = t.category || 'uncategorized'
      if (!byCategory[cat]) byCategory[cat] = []
      byCategory[cat].push(t.summary || t.content.slice(0, 200))
    }

    const grouped = Object.entries(byCategory)
      .map(([cat, items]) => `${cat.toUpperCase()} (${items.length}):\n${items.map(i => `- ${i}`).join('\n')}`)
      .join('\n\n')

    const prompt = `Here are notes captured over the last 7 days, grouped by category:

${grouped}

Write a short weekly digest with three parts:
1. What I've been learning (2-3 sentences)
2. Key themes across these notes (a short bullet list)
3. One open question I seem to be exploring, based on these notes

Keep it under 250 words total. Write it directly to me, second person.`

    const llmRes = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        prompt,
        maxTokens: 600,
        userId: OWNER_USER_ID,
        source: 'weekly-digest',
      }),
    })

    if (!llmRes.ok) {
      const errText = await llmRes.text()
      console.error('weekly-digest: call-llm failed:', errText)
      return new Response(JSON.stringify({ ok: false, error: errText }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { text } = await llmRes.json()
    const digestContent = `📊 Weekly Digest — ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}\n\n${text}`

    await dbFetch('thoughts', {
      method: 'POST',
      body: JSON.stringify({
        content: digestContent,
        user_id: OWNER_USER_ID,
        category: 'digest',
      }),
    })

    return new Response(JSON.stringify({ ok: true, thoughtCount: thoughts.length }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('weekly-digest error:', String(err))
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
