// Bounds on how much PRIOR conversation gets fed back into the model as
// context (separate from MAX_HISTORY_MESSAGES in chatViewProvider.ts, which
// only bounds what's persisted for display). Kept deliberately smaller than
// the display history so a long session doesn't balloon token cost/latency
// on every question.
export const MAX_CONTEXT_TURNS = 12;          // most recent prior user+assistant messages to include
export const MAX_CONTEXT_ENTRY_CHARS = 1500;  // per-message cap when replayed as context
export const MAX_CONTEXT_TOTAL_CHARS = 8000;  // combined cap across all prior context messages

export interface ChatHistoryEntry {
  sender: 'user' | 'assistant';
  text: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Converts persisted chat history into a bounded message array suitable for
 * the model's `messages` field, then appends the current turn's full prompt.
 *
 * Bounding rules (see MAX_CONTEXT_* constants):
 * - Only the most recent MAX_CONTEXT_TURNS prior messages are considered.
 * - Each replayed message is capped at MAX_CONTEXT_ENTRY_CHARS.
 * - The combined size of all replayed messages is capped at
 *   MAX_CONTEXT_TOTAL_CHARS; if exceeded, the OLDEST kept turns are dropped
 *   first (we walk from most-recent backwards and stop once the budget is
 *   used up), so recent context is preserved over older context.
 * - If dropping messages leaves a leading assistant message with no
 *   preceding user message, that dangling leading message is dropped too,
 *   so the conversation always opens on a user turn.
 */
export function buildConversationMessages(
  priorHistory: ChatHistoryEntry[],
  currentPrompt: string
): ConversationMessage[] {
  const recent = priorHistory.slice(-MAX_CONTEXT_TURNS);

  const kept: ConversationMessage[] = [];
  let totalChars = 0;

  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    let content = entry.text;
    if (content.length > MAX_CONTEXT_ENTRY_CHARS) {
      content = content.slice(0, MAX_CONTEXT_ENTRY_CHARS) + '\n...(truncated for context)';
    }
    if (totalChars + content.length > MAX_CONTEXT_TOTAL_CHARS) {
      break; // budget used up; remaining (older) entries are dropped
    }
    totalChars += content.length;
    kept.unshift({ role: entry.sender === 'user' ? 'user' : 'assistant', content });
  }

  while (kept.length > 0 && kept[0].role !== 'user') {
    kept.shift();
  }

  kept.push({ role: 'user', content: currentPrompt });
  return kept;
}
