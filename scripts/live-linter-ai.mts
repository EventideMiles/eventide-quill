/**
 * LIVE linter-AI harness — NOT part of the test suite.
 *
 * Drives the real `suggestLintFix` flow (real prompt construction via
 * getSystemPrompt('linter') + getLinterUserPrompt, real extractReplacement)
 * against a running LM Studio instance, then simulates applyReplacement to
 * show the exact text that would land in the editor.
 *
 * Run via the esbuild bundle helper (see run-live.sh / instructions in chat):
 *   MODEL="google_gemma-4-26b-a4b-it@q4_k_l" node <bundle>
 *
 * The provider stub does a non-streaming POST to /v1/chat/completions with the
 * same body shape the real OpenAiCompatibleProvider builds, so the model sees
 * an identical request to what the plugin sends in Obsidian.
 */
import type { AiProvider, ChatChunk, ChatOptions, ProviderConfig } from '../src/ai/provider';
import { suggestLintFix } from '../src/ai/linter-ai';
import { getSystemPrompt, getLinterUserPrompt } from '../src/ai/prompts';
import type { LintResult } from '../src/core/linter/types';

const ENDPOINT = process.env.LM_ENDPOINT ?? 'http://127.0.0.1:1234';
const MODEL = process.env.MODEL ?? 'google_gemma-4-26b-a4b-it@q4_k_l';

interface Case {
    name: string;
    rule: string;
    line: string;
    column: number;
    length: number;
}

const cases: Case[] = [
    {
        name: 'qualifier "really" at line start (the reported repro)',
        rule: 'qualifiers',
        line: 'really non-existent problem here, but it gets worse.',
        column: 0,
        length: 6
    },
    {
        name: 'qualifier "very" mid-line with long tail',
        rule: 'qualifiers',
        line: 'She was very tired and went to bed early because she had a long day tomorrow.',
        column: 8,
        length: 4
    },
    {
        name: 'qualifier "quite" mid-line',
        rule: 'qualifiers',
        line: 'The castle was quite imposing against the grey sky.',
        column: 15,
        length: 5
    },
    {
        name: 'adverb "slowly" near line end',
        rule: 'adverbs',
        line: 'He walked slowly down the long hallway.',
        column: 10,
        length: 6
    },
    {
        name: 'filler adverb "quietly"',
        rule: 'ai-filler-adverbs',
        line: 'She quietly opened the door and stepped inside the room.',
        column: 4,
        length: 7
    },
    {
        name: 'qualifier "really" mid-sentence',
        rule: 'qualifiers',
        line: 'The dragon was really angry about the stolen gold.',
        column: 15,
        length: 6
    }
];

function makeProvider(): { provider: AiProvider; state: { lastRaw: string } } {
    const config: ProviderConfig = {
        id: 'lm-studio',
        name: 'LM Studio Local',
        type: 'openai-compatible',
        endpoint: ENDPOINT,
        apiKey: '',
        models: [{ id: MODEL, role: 'chat', model: MODEL }],
        maxContextTokens: 32768,
        maxOutputTokens: 512
    };
    // Shared by reference — the generator writes, the caller reads.
    const state = { lastRaw: '' };
    const provider: AiProvider = {
        id: 'lm-studio',
        name: 'LM Studio Local',
        config,
        async *chatCompletion(options: ChatOptions): AsyncGenerator<ChatChunk> {
            const body = {
                model: MODEL,
                messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
                temperature: options.temperature ?? 0.7,
                max_tokens: options.maxTokens ?? 512,
                stream: true
            };
            const res = await fetch(`${ENDPOINT}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => res.statusText)}`);
            }
            // Parse SSE exactly like the plugin's OpenAiCompatibleProvider:
            // concatenate `data:` lines, stop at [DONE], accumulate delta.content.
            const reader = res.body?.getReader();
            if (!reader) throw new Error('No response body');
            const decoder = new TextDecoder();
            let buffer = '';
            let text = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    const payload = trimmed.slice(5).trim();
                    if (payload === '[DONE]') continue;
                    try {
                        const json = JSON.parse(payload) as {
                            choices?: Array<{ delta?: { content?: string } }>;
                        };
                        const piece = json.choices?.[0]?.delta?.content ?? '';
                        if (piece) text += piece;
                    } catch {
                        // ignore malformed keepalive/partial lines
                    }
                }
            }
            state.lastRaw = text;
            yield { text, done: true };
        },
        async embed() {
            return { embeddings: [], model: MODEL };
        },
        async listModels() {
            return [];
        },
        async testConnection() {
            return { ok: true };
        },
        async testEmbeddings() {
            return { ok: true };
        }
    };
    return { provider, state };
}

function applyToLine(line: string, column: number, length: number, replacement: string): string {
    return line.slice(0, column) + replacement + line.slice(column + length);
}

/** Detect an adjacent repeated word (case-insensitive) introduced by the edit. */
function introducedDup(original: string, result: string): string | null {
    const re = /\b(\w+)(\s+\1\b)/gi;
    const originalDups = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(original)) !== null) {
        originalDups.add(m[1].toLowerCase());
    }
    re.lastIndex = 0;
    while ((m = re.exec(result)) !== null) {
        if (!originalDups.has(m[1].toLowerCase())) {
            return m[1];
        }
    }
    return null;
}

function bar(c: string, n = 78): string {
    return c.repeat(n);
}

async function runCase(
    c: Case,
    provider: AiProvider,
    state: { lastRaw: string },
    customInstruction?: string
): Promise<{ dup: boolean; err: boolean }> {
    const flagged = c.line.slice(c.column, c.column + c.length);
    const result: LintResult = {
        line: 2,
        column: c.column,
        length: c.length,
        message: '',
        severity: 'warning',
        rule: c.rule
    };
    const editorText = `The night was cold.\n${c.line}\nNothing moved in the dark.`;

    console.log(`\n${bar('-')}`);
    console.log(`CASE: ${c.name}${customInstruction ? '  [full-line mode]' : ''}`);
    console.log(`  rule:   ${c.rule}`);
    console.log(`  line:   ${c.line}`);
    console.log(`  flagged: "${flagged}" [col ${c.column}, len ${c.length}]`);

    state.lastRaw = '';
    let replacement: string | null;
    try {
        replacement = await suggestLintFix(result, editorText, provider, {
            temperature: 0.3,
            maxTokens: 256,
            model: MODEL
        }, customInstruction);
    } catch (err) {
        console.log(`  ⚠ ERROR: ${(err as Error).message}`);
        return { dup: false, err: true };
    }

    const raw = state.lastRaw;
    console.log(`  raw AI: ${JSON.stringify(raw)}`);
    console.log(`  replacement: ${replacement === null ? 'null (NO_FIX_NEEDED/empty)' : JSON.stringify(replacement)}`);

    if (replacement === null) {
        console.log(`  result line: (no change)`);
        console.log(`  STATUS: NO FIX`);
        return { dup: false, err: false };
    }

    const resultLine = applyToLine(c.line, c.column, c.length, replacement);
    console.log(`  result line: ${resultLine}`);

    const dup = introducedDup(c.line, resultLine);
    if (dup) {
        console.log(`  STATUS: ⚠ DUPLICATION DETECTED — word "${dup}" repeated`);
        return { dup: true, err: false };
    }
    console.log(`  STATUS: ok (no duplication)`);
    return { dup: false, err: false };
}

async function main(): Promise<void> {
    const { provider, state } = makeProvider();
    console.log(`\n${bar('=')}`);
    console.log(`LIVE linter-AI harness  |  endpoint: ${ENDPOINT}`);
    console.log(`model: ${MODEL}`);
    console.log(bar('='));

    // Optional prompt dump for the first case, for diagnosing model behavior.
    if (process.env.DUMP_PROMPT) {
        const c = cases[0];
        const editorText = `The night was cold.\n${c.line}\nNothing moved in the dark.`;
        const lr: LintResult = { line: 2, column: c.column, length: c.length, message: '', severity: 'warning', rule: c.rule };
        const before = 'The night was cold.';
        const after = 'Nothing moved in the dark.';
        const sys = getSystemPrompt('linter', { wikiLinkBehavior: 'preserve' });
        const usr = getLinterUserPrompt(lr, { before, line: c.line, after }, undefined);
        console.log('\n--- SYSTEM PROMPT ---\n' + sys);
        console.log('\n--- USER PROMPT ---\n' + usr);
        return;
    }

    let dupCount = 0;
    let errCount = 0;

    console.log(`\n${bar('#')}\n# PASS 1 — default instructions (model returns DELETE / fragment)\n${bar('#')}`);
    for (const c of cases) {
        const r = await runCase(c, provider, state);
        if (r.dup) dupCount++;
        if (r.err) errCount++;
    }

    // PASS 2 forces the bug-triggering behavior: a less-obedient model (or a
    // custom instruction) returns the FULL corrected line instead of DELETE.
    // Pre-fix this caused word duplication; CASE 1.5 now catches it.
    console.log(`\n${bar('#')}\n# PASS 2 — full-line mode (custom instruction: return the whole corrected line)\n${bar('#')}`);
    const fullLineInstruction =
        'Ignore the "output only the replacement" rule. Instead, output the COMPLETE corrected line in full, with the flagged word removed.';
    for (const c of cases) {
        const r = await runCase(c, provider, state, fullLineInstruction);
        if (r.dup) dupCount++;
        if (r.err) errCount++;
    }

    const totalCases = cases.length * 2;
    console.log(`\n${bar('=')}`);
    console.log(`SUMMARY: ${totalCases} runs | ${dupCount} duplication | ${errCount} errors`);
    console.log(bar('=') + '\n');
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
