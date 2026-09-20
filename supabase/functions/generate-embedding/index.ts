// Supabase Edge Function: generate-embedding
// Converts text into a 1536-number vector representing its meaning, via
// OpenRouter (which can route to any embedding provider through one API).
// To switch embedding providers, change the model string below. The vector
// dimension must stay 1536 or you need a new migration (a different column
// width in the database).

const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const { text } = await req.json()
    if (!text || typeof text !== 'string') {
      return new Response(JSON.stringify({ embedding: null, error: 'text is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)

    try {
      const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'openai/text-embedding-3-small',
          input: text.slice(0, 8000),
        }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (!res.ok) {
        const errText = await res.text()
        console.error('generate-embedding: API error:', res.status, errText)
        return new Response(JSON.stringify({ embedding: null, error: errText }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const data = await res.json()
      const embedding = data?.data?.[0]?.embedding ?? null

      return new Response(JSON.stringify({ embedding }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    } catch (fetchErr) {
      clearTimeout(timeout)
      console.error('generate-embedding: fetch failed:', String(fetchErr))
      return new Response(JSON.stringify({ embedding: null, error: String(fetchErr) }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
  } catch (err) {
    console.error('generate-embedding error:', String(err))
    return new Response(JSON.stringify({ embedding: null, error: String(err) }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
