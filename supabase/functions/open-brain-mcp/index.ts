// Supabase Edge Function: open-brain-mcp
// An MCP (Model Context Protocol) server. Claude Desktop talks to this over
// JSON-RPC 2.0. It exposes three tools that read/write the thoughts table.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID')!
const MCP_ACCESS_KEY = Deno.env.get('MCP_ACCESS_KEY')!

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

const TOOLS = [
  {
    name: 'search_thoughts',
    description: 'Search saved thoughts by keyword. Returns up to 10 matches.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Word or phrase to search for' } },
      required: ['query'],
    },
  },
  {
    name: 'list_recent',
    description: 'List the most recently saved thoughts.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many to return (default 10)' } },
    },
  },
  {
    name: 'add_thought',
    description: 'Save a new thought to the brain.',
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string', description: 'The text to save' } },
      required: ['content'],
    },
  },
]

async function callTool(name: string, args: Record<string, unknown>) {
  if (name === 'search_thoughts') {
    const query = String(args.query ?? '').trim()
    if (!query) return 'Please provide a search query.'
    const rows = await dbFetch(
      `thoughts?user_id=eq.${OWNER_USER_ID}&content=ilike.*${encodeURIComponent(query)}*&order=created_at.desc&limit=10`
    )
    if (!rows.length) return `No thoughts found matching "${query}".`
    return rows.map((r: any, i: number) =>
      `${i + 1}. [${r.created_at}] ${r.content}`
    ).join('\n\n')
  }

  if (name === 'list_recent') {
    const limit = Number(args.limit) > 0 ? Number(args.limit) : 10
    const rows = await dbFetch(
      `thoughts?user_id=eq.${OWNER_USER_ID}&order=created_at.desc&limit=${limit}`
    )
    if (!rows.length) return 'No thoughts saved yet.'
    return rows.map((r: any, i: number) =>
      `${i + 1}. [${r.created_at}] ${r.content}`
    ).join('\n\n')
  }

  if (name === 'add_thought') {
    const content = String(args.content ?? '').trim()
    if (!content) return 'Please provide content to save.'
    const rows = await dbFetch('thoughts?on_conflict=dedup_key,user_id', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ content, user_id: OWNER_USER_ID }),
    })
    return `Saved: "${rows[0]?.content ?? content}"`
  }

  throw new Error(`Unknown tool: ${name}`)
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const auth = req.headers.get('Authorization') ?? ''
  const providedKey = auth.replace(/^Bearer\s+/i, '')
  if (providedKey !== MCP_ACCESS_KEY) {
    return new Response(JSON.stringify(rpcError(null, -32001, 'Unauthorized')), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, 'Parse error')), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const { id, method, params } = body

  if (id === undefined || id === null) {
    return new Response(null, { status: 202, headers: corsHeaders })
  }

  try {
    if (method === 'initialize') {
      return json(rpcResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'open-brain-mcp', version: '1.0.0' },
      }))
    }

    if (method === 'tools/list') {
      return json(rpcResult(id, { tools: TOOLS }))
    }

    if (method === 'tools/call') {
      const toolName = params?.name
      const args = params?.arguments ?? {}
      const text = await callTool(toolName, args)
      return json(rpcResult(id, { content: [{ type: 'text', text }] }))
    }

    return json(rpcResult(id, {}))
  } catch (err) {
    console.error('[open-brain-mcp] error:', String(err))
    return json(rpcError(id, -32000, String(err)))
  }

  function json(payload: unknown) {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
