// Supabase Edge Function: capture-url
// Fetches a web page on the server (where CORS doesn't apply), strips it
// down to readable text, and saves it. No AI summary yet — that's Level 5.

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

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>',
  rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', iexcl: '¡', iquest: '¿',
}

function decodeEntities(s: string): string {
  return s
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name === 'amp' ? m : NAMED_ENTITIES[name] ?? m))
    .replace(/&#(?!0*38;)(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x(?!0*26;)([0-9a-fA-F]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

function htmlToText(html: string): { title: string; text: string } {
  const titleMatch =
    html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : 'Untitled page'

  const articleMatch =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  const body = articleMatch ? articleMatch[1] : html

  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  const cleaned = decodeEntities(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n').trim()

  return { title, text: cleaned }
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

    const { url } = await req.json()
    if (!url || typeof url !== 'string') return jsonResponse({ ok: false, error: 'A url is required' }, 400)

    let parsed: URL
    try { parsed = new URL(url) } catch {
      return jsonResponse({ ok: false, error: 'That is not a valid web address' }, 400)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return jsonResponse({ ok: false, error: 'Only http and https links are supported' }, 400)
    }

    const pageRes = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })

    if (!pageRes.ok) {
      return jsonResponse({ ok: false, error: `That page returned HTTP ${pageRes.status}. It may require a login or block automated readers.` }, 422)
    }

    const contentType = pageRes.headers.get('content-type') ?? ''
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return jsonResponse({ ok: false, error: 'That link is not a web page. For PDFs, use the PDF tab instead.' }, 415)
    }

    const raw = await pageRes.text()
    const { title, text } = htmlToText(raw)

    if (text.length < 200) {
      return jsonResponse({ ok: false, error: 'Almost no readable text was found — the page may build itself with JavaScript, which a server cannot see.' }, 422)
    }

    const content = `🔗 ${title}\n${parsed.hostname}\n\n${text.slice(0, 4000)}`

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const { data: thought, error: insertErr } = await admin.from('thoughts')
      .insert({
        user_id: user.id,
        content,
        metadata: { title, url: parsed.toString(), hostname: parsed.hostname },
      })
      .select('id').single()
    if (insertErr) throw insertErr

    try {
      await admin.from('thought_sources').insert({
        thought_id: thought.id, user_id: user.id,
        source_text: text, source_kind: 'web',
        char_count: text.length, truncated: false,
      })
    } catch (srcErr) { console.warn('thought_sources insert failed', srcErr) }

    return jsonResponse({ ok: true, title, hostname: parsed.hostname, preview: content.slice(0, 240) + '…' })
  } catch (err) {
    console.error('[url] Failed:', String(err))
    return jsonResponse({ ok: false, error: String(err) }, 500)
  }
})
