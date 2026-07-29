import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildConversationMessages, ChatHistoryEntry } from '../conversationContext';

function entry(sender: 'user' | 'assistant', text: string): ChatHistoryEntry {
  return { sender, text };
}

describe('buildConversationMessages', () => {
  test('with no prior history, returns just the current prompt as a user message', () => {
    const result = buildConversationMessages([], 'What framework does this use?');
    assert.deepEqual(result, [{ role: 'user', content: 'What framework does this use?' }]);
  });

  test('replays prior turns in order, then appends the current prompt last', () => {
    const history: ChatHistoryEntry[] = [
      entry('user', 'What framework does this use?'),
      entry('assistant', 'This project uses Express and React.')
    ];
    const result = buildConversationMessages(history, 'Does it use a database?');

    assert.deepEqual(result, [
      { role: 'user', content: 'What framework does this use?' },
      { role: 'assistant', content: 'This project uses Express and React.' },
      { role: 'user', content: 'Does it use a database?' }
    ]);
  });

  test('keeps only the most recent MAX_CONTEXT_TURNS prior messages', () => {
    // 20 prior turns (10 exchanges) — comfortably over the 12-message cap.
    const history: ChatHistoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      history.push(entry('user', `question ${i}`));
      history.push(entry('assistant', `answer ${i}`));
    }

    const result = buildConversationMessages(history, 'final question');

    // 12 replayed + 1 current = 13, and the oldest turns must be the ones dropped.
    assert.equal(result.length, 13);
    assert.equal(result[0].content, 'question 4'); // turns for i=0..3 dropped
    assert.equal(result[result.length - 1].content, 'final question');
  });

  test('truncates any single message longer than the per-entry cap', () => {
    const longText = 'x'.repeat(2000); // over the 1500-char per-entry cap
    const history: ChatHistoryEntry[] = [entry('user', longText)];

    const result = buildConversationMessages(history, 'follow-up');

    assert.ok(result[0].content.length < longText.length);
    assert.ok(result[0].content.endsWith('...(truncated for context)'));
  });

  test('drops oldest replayed messages first when the combined char budget is exceeded', () => {
    // Each message ~1000 chars; 8000-char total budget means roughly the
    // last 8 fit, so the earliest ones should be dropped, not the latest.
    const history: ChatHistoryEntry[] = [];
    for (let i = 0; i < 12; i++) {
      history.push(entry(i % 2 === 0 ? 'user' : 'assistant', `msg${i}-` + 'y'.repeat(990)));
    }

    const result = buildConversationMessages(history, 'final question');

    const totalReplayedChars = result
      .slice(0, -1)
      .reduce((sum, m) => sum + m.content.length, 0);
    assert.ok(totalReplayedChars <= 8000);

    // The most recent prior message (msg11) must be present; an early one (msg0) must not.
    assert.ok(result.some(m => m.content.startsWith('msg11-')));
    assert.ok(!result.some(m => m.content.startsWith('msg0-')));
  });

  test('drops a dangling leading assistant message so the conversation opens on a user turn', () => {
    // Simulates trimming cutting off mid-exchange, leaving an assistant
    // message with no preceding user message in the kept window.
    const history: ChatHistoryEntry[] = [
      entry('assistant', 'orphaned answer with no preceding question in this window'),
      entry('user', 'a real question'),
      entry('assistant', 'a real answer')
    ];

    const result = buildConversationMessages(history, 'final question');

    assert.equal(result[0].role, 'user');
    assert.equal(result[0].content, 'a real question');
  });
});
