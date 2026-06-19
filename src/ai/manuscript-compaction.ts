import type { AiProvider, ChatMessage } from './provider';
import { estimateTokens } from '../utils/tokens';
import { cosineSimilarity } from './embedding-cache';

/** Compaction strategy for manuscript analysis. */
export type CompactionStrategy = 'full' | 'embed' | 'compress';

/** A single chunk of manuscript text. */
export interface Chunk {
    index: number;
    text: string;
    tokenEstimate: number;
    filePath?: string;
    chapterTitle?: string;
    embedding?: number[];
    hash?: string;
}

/** Options for chunking. */
export interface ChunkOptions {
    targetTokenSize: number;
    overlap?: number;
}

const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
    targetTokenSize: 1024,
    overlap: 0.1
};

/**
 * Split manuscript text into ~targetTokenSize chunks.
 *
 * Splits on paragraph boundaries (double newline) first. If a single
 * paragraph exceeds the target, it is further split at sentence boundaries.
 * If a single sentence still exceeds the target, it is hard-split at the
 * character boundary as a last resort.
 *
 * Uses a conservative 3 chars/token ratio (instead of the 4 used by
 * `estimateTokens`) so chunks stay under the limit even for models with
 * aggressive tokenizers (e.g. nomic-embed-text at ~3 chars/token).
 */
export function chunkManuscript(
    text: string,
    options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
    filePath?: string,
    chapterTitle?: string
): Chunk[] {
    const target = options.targetTokenSize;
    const overlap = options.overlap ?? 0.1;
    // Conservative: 2.5 chars/token. Some embedding models (especially GGUF/local
    // models like nomic-embed-text) tokenize more aggressively than the 4 chars/token
    // rule of thumb, producing ~2.6-3 chars/token. Using 2.5 ensures chunks stay
    // under the model's context window even for aggressive tokenizers.
    const charsPerToken = 2.5;
    const overlapChars = Math.floor(target * overlap * charsPerToken);
    const targetChars = target * charsPerToken;

    // --- Pass 1: produce "units" that each fit within targetChars ---
    // A unit is a paragraph, or a sentence-level fragment from an oversized paragraph.
    const units: string[] = [];
    const paragraphs = text.split(/\n\n+/);

    for (const para of paragraphs) {
        if (para.length <= targetChars) {
            units.push(para);
            continue;
        }

        // Oversized paragraph — split at sentence boundaries.
        const sentences = para.match(/[^.!?]+[.!?]+["')\]]?\s*/g) ?? [para];
        let sentenceBuf = '';

        for (const sentence of sentences) {
            if (sentence.length > targetChars) {
                // Single sentence still too long — flush buffer, hard-split the sentence.
                if (sentenceBuf) {
                    units.push(sentenceBuf);
                    sentenceBuf = '';
                }
                for (let i = 0; i < sentence.length; i += targetChars) {
                    units.push(sentence.substring(i, i + targetChars));
                }
            } else if (sentenceBuf.length + sentence.length > targetChars) {
                units.push(sentenceBuf);
                sentenceBuf = sentence;
            } else {
                sentenceBuf += sentence;
            }
        }
        if (sentenceBuf) units.push(sentenceBuf);
    }

    // --- Pass 2: accumulate units into chunks with overlap ---
    const chunks: Chunk[] = [];
    let current: string[] = [];
    let currentLen = 0;

    for (const unit of units) {
        if (currentLen + unit.length > targetChars && current.length > 0) {
            const chunkText = current.join('\n\n');
            chunks.push({
                index: chunks.length,
                text: chunkText,
                tokenEstimate: estimateTokens(chunkText),
                filePath,
                chapterTitle
            });

            // Overlap: re-add trailing units from the previous chunk.
            const overlapTexts: string[] = [];
            let overlapLen = 0;
            for (let i = current.length - 1; i >= 0; i--) {
                const u = current[i]!;
                if (overlapLen + u.length > overlapChars) break;
                overlapTexts.unshift(u);
                overlapLen += u.length;
            }
            current = overlapTexts;
            currentLen = overlapLen;
        }
        current.push(unit);
        currentLen += unit.length;
    }

    // Flush remaining.
    if (current.length > 0) {
        const chunkText = current.join('\n\n');
        chunks.push({
            index: chunks.length,
            text: chunkText,
            tokenEstimate: estimateTokens(chunkText),
            filePath,
            chapterTitle
        });
    }

    return chunks;
}

/**
 * Embed chunks and rank them by cosine similarity to the query.
 * Returns the top-K chunks.
 */
export async function rankChunks(
    provider: AiProvider,
    chunks: Chunk[],
    query: string,
    topK: number = 10,
    model?: string
): Promise<Chunk[]> {
    if (chunks.length === 0) return [];

    const inputs = chunks.map((c) => c.text);
    inputs.push(query);

    const result = await provider.embed({ input: inputs, model });
    if (result.embeddings.length < inputs.length) {
        return chunks.slice(0, topK);
    }

    const queryEmbedding = result.embeddings[result.embeddings.length - 1]!;
    const scored: { chunk: Chunk; score: number }[] = [];

    for (let i = 0; i < chunks.length; i++) {
        const chunkEmbedding = result.embeddings[i];
        if (!chunkEmbedding) continue;
        const score = cosineSimilarity(chunkEmbedding, queryEmbedding);
        scored.push({ chunk: chunks[i]!, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.chunk);
}

/**
 * Compress chunks by sending each to the chat LLM for summarization.
 * Returns the concatenated summary text.
 */
export async function compressChunks(
    provider: AiProvider,
    chunks: Chunk[],
    options: {
        model?: string;
        signal?: AbortSignal;
        onChunkProgress?: (index: number, total: number) => void;
    } = {}
): Promise<string> {
    const summaries: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        options.onChunkProgress?.(i + 1, chunks.length);

        const messages: ChatMessage[] = [
            {
                role: 'system',
                content:
                    'Compress this chapter section for manuscript analysis. ' +
                    'Preserve: narrative structure, characters and their actions, ' +
                    'key events, pacing signals, sensory details, dialogue snippets ' +
                    'that reveal voice. Output in 2-3 concise sentences.'
            },
            {
                role: 'user',
                content: chunk.text
            }
        ];

        let summary = '';
        const stream = provider.chatCompletion({
            messages,
            model: options.model,
            temperature: 0.3,
            maxTokens: 512,
            signal: options.signal
        });

        for await (const chunk of stream) {
            if (chunk.done) break;
            summary += chunk.text;
        }

        if (summary.trim()) {
            const prefix = chunk.filePath
                ? `[${chunk.filePath}${chunk.chapterTitle ? ` / ${chunk.chapterTitle}` : ''}] `
                : '';
            summaries.push(`${prefix}${summary.trim()}`);
        }
    }

    return summaries.join('\n\n');
}
