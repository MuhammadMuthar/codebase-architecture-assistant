"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const conversationContext_1 = require("../conversationContext");
function entry(sender, text) {
    return { sender, text };
}
(0, node_test_1.describe)('buildConversationMessages', () => {
    (0, node_test_1.test)('with no prior history, returns just the current prompt as a user message', () => {
        const result = (0, conversationContext_1.buildConversationMessages)([], 'What framework does this use?');
        strict_1.default.deepEqual(result, [{ role: 'user', content: 'What framework does this use?' }]);
    });
    (0, node_test_1.test)('replays prior turns in order, then appends the current prompt last', () => {
        const history = [
            entry('user', 'What framework does this use?'),
            entry('assistant', 'This project uses Express and React.')
        ];
        const result = (0, conversationContext_1.buildConversationMessages)(history, 'Does it use a database?');
        strict_1.default.deepEqual(result, [
            { role: 'user', content: 'What framework does this use?' },
            { role: 'assistant', content: 'This project uses Express and React.' },
            { role: 'user', content: 'Does it use a database?' }
        ]);
    });
    (0, node_test_1.test)('keeps only the most recent MAX_CONTEXT_TURNS prior messages', () => {
        // 20 prior turns (10 exchanges) — comfortably over the 12-message cap.
        const history = [];
        for (let i = 0; i < 10; i++) {
            history.push(entry('user', `question ${i}`));
            history.push(entry('assistant', `answer ${i}`));
        }
        const result = (0, conversationContext_1.buildConversationMessages)(history, 'final question');
        // 12 replayed + 1 current = 13, and the oldest turns must be the ones dropped.
        strict_1.default.equal(result.length, 13);
        strict_1.default.equal(result[0].content, 'question 4'); // turns for i=0..3 dropped
        strict_1.default.equal(result[result.length - 1].content, 'final question');
    });
    (0, node_test_1.test)('truncates any single message longer than the per-entry cap', () => {
        const longText = 'x'.repeat(2000); // over the 1500-char per-entry cap
        const history = [entry('user', longText)];
        const result = (0, conversationContext_1.buildConversationMessages)(history, 'follow-up');
        strict_1.default.ok(result[0].content.length < longText.length);
        strict_1.default.ok(result[0].content.endsWith('...(truncated for context)'));
    });
    (0, node_test_1.test)('drops oldest replayed messages first when the combined char budget is exceeded', () => {
        // Each message ~1000 chars; 8000-char total budget means roughly the
        // last 8 fit, so the earliest ones should be dropped, not the latest.
        const history = [];
        for (let i = 0; i < 12; i++) {
            history.push(entry(i % 2 === 0 ? 'user' : 'assistant', `msg${i}-` + 'y'.repeat(990)));
        }
        const result = (0, conversationContext_1.buildConversationMessages)(history, 'final question');
        const totalReplayedChars = result
            .slice(0, -1)
            .reduce((sum, m) => sum + m.content.length, 0);
        strict_1.default.ok(totalReplayedChars <= 8000);
        // The most recent prior message (msg11) must be present; an early one (msg0) must not.
        strict_1.default.ok(result.some(m => m.content.startsWith('msg11-')));
        strict_1.default.ok(!result.some(m => m.content.startsWith('msg0-')));
    });
    (0, node_test_1.test)('drops a dangling leading assistant message so the conversation opens on a user turn', () => {
        // Simulates trimming cutting off mid-exchange, leaving an assistant
        // message with no preceding user message in the kept window.
        const history = [
            entry('assistant', 'orphaned answer with no preceding question in this window'),
            entry('user', 'a real question'),
            entry('assistant', 'a real answer')
        ];
        const result = (0, conversationContext_1.buildConversationMessages)(history, 'final question');
        strict_1.default.equal(result[0].role, 'user');
        strict_1.default.equal(result[0].content, 'a real question');
    });
});
//# sourceMappingURL=conversationMessages.test.js.map