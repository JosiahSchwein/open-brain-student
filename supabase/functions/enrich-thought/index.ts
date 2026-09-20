// Supabase Edge Function: enrich-thought
// Triggered by a database trigger on INSERT into thoughts.
// Calls the LLM gateway for tags/category/summary, then generates and stores
// an embedding for semantic search and graph linking, then chunks long
// captures for paragraph-level retrieval (Level 7).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { saveThoughtChunksSafe } from '../_shared/thought-chunks.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function ok() {
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

    let parsed: { tags?: string[]; category?: string; summary?: string } = {}
    if (llmRes.ok) {
      const { text } = await llmRes.json()
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/)
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text)
      } catch (e) {
        console.error('enrich-thought: could not parse LLM response:', text)
      }
    } else {
      console.error('enrich-thought: call-llm failed:', await llmRes.text())
    }

    let embedding: number[] | null = null
    try {
      const embResponse = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE_KEY}` },
        body: JSON.stringify({ text: content }),
      })
      const embData = await embResponse.json()
      embedding = embData?.embedding ?? null
    } catch (embErr) {
      console.error('enrich-thought: embedding generation failed (non-fatal):', String(embErr))
    }

    const updatePayload: Record<string, unknown> = {
      tags: parsed.tags ?? [],
      category: parsed.category ?? null,
      summary: parsed.summary ?? null,
      enriched_at: new Date().toISOString(),
    }
    if (embedding) updatePayload.embedding = embedding

    const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/thoughts?id=eq.${thoughtId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(updatePayload),
    })

    if (!updateRes.ok) {
      console.error('enrich-thought: update failed:', await updateRes.text())
    }

    if (embedding) {
      try {
        const linkRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/link_related_thoughts`, {
          method: 'POST',
          headers: {
            'apikey': SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            p_thought_id: thoughtId,
            p_user_id: userId,
            p_embedding: embedding,
          }),
        })
        if (!linkRes.ok) {
          console.error('enrich-thought: linking failed:', await linkRes.text())
        }
      } catch (linkErr) {
        console.error('enrich-thought: linking failed (non-fatal):', String(linkErr))
      }
    }

    await saveThoughtChunksSafe(supabase, thoughtId, content, 'enrich-thought', 'summary')

    return ok()
  } catch (err) {
    console.error('enrich-thought error:', String(err))
    return ok()
  }
})
