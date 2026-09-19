// Supabase Edge Function: call-llm
// The LLM gateway. Every agent calls THIS function instead of calling an AI
// provider directly. To switch providers, change LLM_PROVIDER and add that
// provider's API key in Supabase secrets. No other code changes needed.

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const LLM_PROVIDER = Deno.env.get('LLM_PROVIDER') ?? 'anthropic'
const LLM_MODEL = Deno.env.get('LLM_MODEL') ?? 'claude-haiku-4-5-20251001'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 0.0000008, output: 0.000004 },
}

async function callAnthropic(prompt: string, systemPrompt: string | undefined, model: string, maxTokens: number) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Anthropic API error: ${res.status} ${text}`)
  }
  const data = await res.json()
  const text = data.content?.[0]?.text ?? ''
  return {
    text,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  }
}

async function logUsage(userId: string | undefined, model: string, source: string | undefined, inputTokens: number, outputTokens: number) {
  if (!userId) {
    console.warn('call-llm: no userId provided, skipping usage log')
    return
  }
  try {
    const price = PRICING[model]
    const cost = price ? inputTokens * price.input + outputTokens * price.output : 0
    const res = await fetch(`${SUPABASE_URL}/rest/v1/llm_usage`, {
      method: 'POST',
      headers: {
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        user_id: userId,
        kind: 'chat',
        model,
        source: source ?? 'unknown',
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        cost_usd: cost,
      }),
    })
    if (!res.ok) {
      console.error('call-llm: usage insert rejected:', res.status, await res.text())
    }
  } catch (err) {
    console.warn('call-llm: usage logging failed (non-fatal):', String(err))
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const { prompt, systemPrompt, model, maxTokens, userId, source } = await req.json()
    if (!prompt) {
      return new Response(JSON.stringify({ error: 'A prompt is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const useModel = model || LLM_MODEL
    const useMaxTokens = maxTokens || 1024

    let result: { text: string; inputTokens: number; outputTokens: number }
    if (LLM_PROVIDER === 'anthropic') {
      result = await callAnthropic(prompt, systemPrompt, useModel, useMaxTokens)
    } else {
      throw new Error(`Unsupported LLM_PROVIDER: ${LLM_PROVIDER}`)
    }

    // Log usage before returning — a fire-and-forget call here can get killed
    // by the runtime the instant the response is sent, before it completes.
    await logUsage(userId, useModel, source, result.inputTokens, result.outputTokens)

    return new Response(JSON.stringify({ text: result.text }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('call-llm error:', String(err))
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
