import { buildTopicContext, detectTopic } from './aiContext'

/* ── Types ─────────────────────────────────────────────────────── */

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

/* ── System prompt ─────────────────────────────────────────────── */

const SYSTEM_PROMPT = `You are the FitBake Production Tracker AI assistant. You help the FitBake team manage their keto dessert production business.

You have access to real-time data from the FitBake production tracker. Use this data to answer questions accurately.

RULES:
- Always reference specific numbers from the data when answering
- If asked about something not in the data, say so honestly
- Give actionable recommendations when appropriate
- Be concise but thorough
- Format responses with clear structure when showing data
- Use dollar amounts and units (lbs, kg, etc.) in answers
- When recommending orders, consider lead times and current stock
- Flag any issues you notice (low stock, high waste, cost increases)

You can help with:
- Inventory levels and stock status at each co-packer
- Ingredient costs and recipe COGS breakdown
- Purchase order status and supplier pricing comparison
- Production order status and procurement tracking
- Recommendations on what to reorder and from which supplier
- Finished goods and fulfillment status
- General business analysis and suggestions`

/* ── API call ──────────────────────────────────────────────────── */

export async function sendMessage(
  userMessage: string,
  conversationHistory: Message[],
): Promise<string> {
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY_MISSING')

  // Build topic-specific context
  const topic = detectTopic(userMessage)
  const context = await buildTopicContext(topic)

  // Keep last 10 messages for API context
  const recent = conversationHistory.slice(-10)

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: SYSTEM_PROMPT + '\n\nCURRENT DATA:\n' + context,
      messages: [
        ...recent.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: userMessage },
      ],
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`API error ${response.status}: ${err}`)
  }

  const data = await response.json()
  return data.content[0].text
}
