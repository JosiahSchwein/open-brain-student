// Supabase Edge Function: telegram-bot
// Receives messages from Telegram's webhook and saves/searches thoughts.

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function dbFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
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

async function sendTelegramMessage(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const update = await req.json()
    const message = update.message
    if (!message || !message.text) {
      return new Response('ok', { status: 200, headers: corsHeaders })
    }

    const chatId = message.chat.id
    const text: string = message.text.trim()

    if (text.startsWith('/search') || text.startsWith('?')) {
      const query = text.replace(/^\/search/, '').replace(/^\?/, '').trim()
      if (!query) {
        await sendTelegramMessage(chatId, 'Send /search followed by a word to look for.')
        return new Response('ok', { status: 200, headers: corsHeaders })
      }
      const rows = await dbFetch(
        `thoughts?user_id=eq.${OWNER_USER_ID}&content=ilike.*${encodeURIComponent(query)}*&order=created_at.desc&limit=5`
      )
      if (!rows.length) {
        await sendTelegramMessage(chatId, `No matches for "${query}".`)
      } else {
        const list = rows.map((r: any, i: number) => `${i + 1}. ${r.content.slice(0, 200)}`).join('\n\n')
        await sendTelegramMessage(chatId, `Found ${rows.length} match(es):\n\n${list}`)
      }
    } else if (text.startsWith('/recent')) {
      const rows = await dbFetch(
        `thoughts?user_id=eq.${OWNER_USER_ID}&order=created_at.desc&limit=5`
      )
      if (!rows.length) {
        await sendTelegramMessage(chatId, 'No thoughts saved yet.')
      } else {
        const list = rows.map((r: any, i: number) => `${i + 1}. ${r.content.slice(0, 200)}`).join('\n\n')
        await sendTelegramMessage(chatId, `Your ${rows.length} most recent:\n\n${list}`)
      }
    } else {
      await dbFetch('thoughts', {
        method: 'POST',
        body: JSON.stringify({ content: text, user_id: OWNER_USER_ID }),
      })
      await sendTelegramMessage(chatId, 'Saved to your brain.')
    }

    return new Response('ok', { status: 200, headers: corsHeaders })
  } catch (err) {
    console.error('telegram-bot error:', err)
    return new Response('ok', { status: 200, headers: corsHeaders })
  }
})
