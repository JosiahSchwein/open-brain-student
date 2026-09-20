// Supabase Edge Function: capture-youtube
// Tries three routes to get a real transcript, in order: Supadata (residential
// IP, needs a free key), Innertube (YouTube's own app API, no key), then falls
// back to the video description if no captions exist anywhere.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPADATA_KEY = Deno.env.get('SUPADATA_API_KEY') ?? ''

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

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

interface VideoContent { content: string; hasTranscript: boolean; source: string }

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ]
  for (const p of patterns) { const m = url.match(p); if (m) return m[1] }
  return null
}

async function fetchTitle(videoUrl: string, videoId: string): Promise<string> {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`, { signal: AbortSignal.timeout(8000) })
    if (res.ok) { const data = await res.json(); if (data?.title) return data.title as string }
  } catch { /* fall through */ }
  return `Video ${videoId}`
}

async function fromSupadata(videoUrl: string): Promise<VideoContent | null> {
  if (!SUPADATA_KEY) return null
  try {
    const res = await fetch(`https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(videoUrl)}&lang=en`, {
      headers: { 'x-api-key': SUPADATA_KEY }, signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) { console.log(`[youtube] Supadata HTTP ${res.status} — falling through`); return null }
    const data = await res.json()
    const segments: Array<{ text?: string }> = data?.content ?? []
    const transcript = segments.map(s => s.text ?? '').join(' ').replace(/\s+/g, ' ').trim()
    if (!transcript) return null
    return { content: transcript, hasTranscript: true, source: 'supadata' }
  } catch (err) { console.error('[youtube] Supadata error:', String(err)); return null }
}

async function fromInnertube(videoId: string): Promise<VideoContent | null> {
  const clients = [
    { name: 'IOS', userAgent: 'com.google.ios.youtube/19.29.1 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      context: { clientName: 'IOS', clientVersion: '19.29.1', deviceMake: 'Apple', deviceModel: 'iPhone17,2', osName: 'iPhone', osVersion: '18.1.0.22B83', hl: 'en', gl: 'US' } },
    { name: 'ANDROID', userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
      context: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en', gl: 'US' } },
  ]

  let best: Record<string, unknown> | null = null
  for (const client of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': client.userAgent },
        body: JSON.stringify({ context: { client: client.context }, videoId }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) continue
      const result = await res.json()
      const tracks = result?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      if (Array.isArray(tracks) && tracks.length > 0) { best = result; break }
      if (!best) best = result
    } catch (err) { console.error(`[youtube] Innertube ${client.name} error:`, String(err)) }
  }
  if (!best) return null

  try {
    const tracks = (best as any)?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    if (Array.isArray(tracks) && tracks.length > 0) {
      const track =
        tracks.find((t: any) => t.languageCode === 'en' && t.kind !== 'asr') ??
        tracks.find((t: any) => t.languageCode === 'en') ??
        tracks.find((t: any) => String(t.languageCode ?? '').startsWith('en')) ??
        tracks[0]
      const capRes = await fetch(track.baseUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(12_000),
      })
      if (capRes.ok) {
        const xml = await capRes.text()
        const transcript = [...xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
          .map(m => decodeEntities(m[1])).join(' ').replace(/\s+/g, ' ').trim()
        if (transcript) return { content: transcript, hasTranscript: true, source: 'innertube' }
      }
    }
    const details = (best as any)?.videoDetails
    const description: string = details?.shortDescription ?? ''
    if (description) return { content: description, hasTranscript: false, source: 'description' }
    return null
  } catch (err) { console.error('[youtube] Innertube parse error:', String(err)); return null }
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
    if (!url || typeof url !== 'string') return jsonResponse({ ok: false, error: 'A YouTube url is required' }, 400)

    const videoId = extractVideoId(url)
    if (!videoId) return jsonResponse({ ok: false, error: 'That does not look like a YouTube link.' }, 400)

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
    const title = await fetchTitle(videoUrl, videoId)

    const result = (await fromSupadata(videoUrl)) ?? (await fromInnertube(videoId))
    if (!result) {
      return jsonResponse({ ok: false, error: 'Could not read anything from that video. It may be private, age-restricted, or region-locked.' }, 422)
    }

    const label = result.hasTranscript ? '' : '(no captions were available — this is the video description only)\n\n'
    const content = `📹 ${title}\n\n${label}${result.content.slice(0, 4000)}`

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const { data: thought, error: insertErr } = await admin.from('thoughts')
      .upsert({
        user_id: user.id,
        content,
        metadata: { title, video_id: videoId, video_url: videoUrl, has_transcript: result.hasTranscript, fetched_via: result.source },
      }, { onConflict: 'dedup_key,user_id', ignoreDuplicates: false })
      .select('id').single()
    if (insertErr) throw insertErr

    try {
      await admin.from('thought_sources').insert({
        thought_id: thought.id, user_id: user.id,
        source_text: result.content,
        source_kind: result.hasTranscript ? 'youtube_transcript' : 'youtube_description',
        char_count: result.content.length, truncated: false,
      })
    } catch (srcErr) { console.warn('thought_sources insert failed', srcErr) }

    return jsonResponse({ ok: true, title, has_transcript: result.hasTranscript, fetched_via: result.source, preview: content.slice(0, 240) + '…' })
  } catch (err) {
    console.error('[youtube] Failed:', String(err))
    return jsonResponse({ ok: false, error: String(err) }, 500)
  }
})
