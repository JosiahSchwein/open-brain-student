/**
 * Writes per-chunk embeddings for a thought that is already saved.
 *
 * The parent thought keeps its own whole-content embedding. Chunks are additive: search takes
 * the better of the document-level match and the best chunk-level match. So if chunking fails,
 * retrieval degrades to exactly the pre-chunking behaviour rather than breaking — which is why
 * callers use saveThoughtChunksSafe.
 *
 * ADAPTED FOR THIS PROJECT: embeddings go through this project's own generate-embedding edge
 * function from Level 6, not a shared ai.ts helper — same self-sovereign, LLM-agnostic pattern.
 */

import { chunkText, shouldChunk } from './chunking.ts'

async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-embedding`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      },
      body: JSON.stringify({ text }),
    })
    const data = await res.json()
    return data?.embedding ?? null
  } catch (err) {
    console.warn('[thought-chunks] embedding call failed:', String(err))
    return null
  }
}

export type ChunkOrigin = 'summary' | 'source'

export async function saveThoughtChunks(
  supabase: any,
  thoughtId: string,
  content: string,
  origin: ChunkOrigin = 'summary',
): Promise<number> {
  if (!thoughtId || !shouldChunk(content)) return 0

  let chunks = chunkText(content)

  if (chunks.length === 0) {
    console.warn(`[thought-chunks] ${thoughtId}: ${content.length} chars produced no chunks; storing whole content as one chunk`)
    chunks = [{ index: 0, text: content, charStart: 0, charEnd: content.length }]
  }

  const embeddings: (number[] | null)[] = []
  for (const c of chunks) {
    embeddings.push(await generateEmbedding(c.text))
  }

  const rows = chunks.map((c, i) => ({
    thought_id: thoughtId,
    origin,
    chunk_index: c.index,
    content: c.text,
    char_start: c.charStart,
    char_end: c.charEnd,
    embedding: embeddings[i],
  }))

  const embedded = embeddings.filter((e) => e !== null).length
  if (embedded < chunks.length) {
    console.warn(`[thought-chunks] ${thoughtId}: ${embedded}/${chunks.length} chunks embedded — the rest are keyword-searchable only`)
  }

  const { error: delErr } = await supabase
    .from('thought_chunks').delete().eq('thought_id', thoughtId).eq('origin', origin)
  if (delErr) throw new Error(`chunk delete failed: ${delErr.message}`)

  const { error: insErr } = await supabase.from('thought_chunks').insert(rows)
  if (insErr) throw new Error(`chunk insert failed: ${insErr.message}`)

  return rows.length
}

export async function saveThoughtChunksSafe(
  supabase: any,
  thoughtId: string,
  content: string,
  label: string,
  origin: ChunkOrigin = 'summary',
): Promise<number> {
  try {
    return await saveThoughtChunks(supabase, thoughtId, content, origin)
  } catch (err) {
    console.error(`[${label}] ${origin} chunking failed (non-fatal):`, String(err))
    return 0
  }
}
