// Supabase Edge Function: enrich-thought
// Triggered by a Supabase Database Webhook on INSERT into thoughts.
// Calls the LLM gateway to get tags/category/summary and writes them back.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function ok() {
  // Webhook functions should never fail from Supabase's point of view.
  return new Response('ok', { status: 200, headers: corsHeaders })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const payload = await req.json()
    const record = payload.record ?? payload.new ?? payload
    const content: string = record?.content ?? ''
    const thoughtId: string = record?.id
    const userId: string = record?.user_id

    if (!thoughtId || !content || content.trim().length < 20) {
      // Too short to be worth enriching, or malformed payload — skip quietly.
      return ok()
    }

    const prompt = `Analyze this note and respond with ONLY a JSON object, no other text:
{
  "tags": ["3 to 5 short lowercase tags"],
  "category": "one of: idea, learning, question, reference, plan, reflection",
  "summary": "one sentence, max 20 words"
}

Note:
"""
${content.slice(0, 3000)}
"""`

    const llmRes = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        prompt,
        maxTokens: 300,
        userId,
        source: 'enrich-thought',
      }),
    })

    if (!llmRes.ok) {
      console.error('enrich-thought: call-llm failed:', await llmRes.text())
      return ok()
    }

    const { text } = await llmRes.json()

    let parsed: { tags?: string[]; category?: string; summary?: string }
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text)
    } catch (e) {
      console.error('enrich-thought: could not parse LLM response:', text)
      return ok()
    }

    const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/thoughts?id=eq.${thoughtId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        tags: parsed.tags ?? [],
        category: parsed.category ?? null,
        summary: parsed.summary ?? null,
        enriched_at: new Date().toISOString(),
      }),
    })

    if (!updateRes.ok) {
      console.error('enrich-thought: update failed:', await updateRes.text())
    }

    return ok()
  } catch (err) {
    console.error('enrich-thought error:', String(err))
    return ok()
  }
})
