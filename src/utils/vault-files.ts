import { TFile, Vault } from 'obsidian';
import type { ChatMessage } from '../ai/provider';

/**
 * Read a single vault file's content as raw text, capped to maxChars.
 * Best-effort: returns empty string if the file cannot be found or read.
 *
 * @param vault     The Obsidian vault.
 * @param filePath  Path to read.
 * @param maxChars  Optional character limit.
 * @returns The file's text (capped), or empty string on failure.
 */
export async function readVaultFileText(vault: Vault, filePath: string, maxChars?: number): Promise<string> {
    try {
        const file = vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return '';
        const content = await vault.cachedRead(file);
        const safeMax =
            typeof maxChars === 'number' && maxChars >= 0 && Number.isFinite(maxChars)
                ? Math.floor(maxChars)
                : undefined;
        return safeMax !== undefined ? content.slice(0, safeMax) : content;
    } catch {
        return '';
    }
}

/**
 * Read vault files by path and return them as system messages.
 * Best-effort: files that cannot be read are silently skipped.
 *
 * @param vault      The Obsidian vault.
 * @param filePaths  Paths to read.
 * @param label      Prefix label for each message (e.g. "Manuscript", "Reference file").
 * @param maxChars   Optional character limit per file. When omitted, full content is used.
 */
export async function readVaultFiles(
    vault: Vault,
    filePaths: string[],
    label: string,
    maxChars?: number
): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];
    for (const filePath of filePaths) {
        try {
            const file = vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                const content = await vault.cachedRead(file);
                const safeMax =
                    typeof maxChars === 'number' && maxChars >= 0 && Number.isFinite(maxChars)
                        ? Math.floor(maxChars)
                        : undefined;
                const excerpt = safeMax !== undefined ? content.slice(0, safeMax) : content;
                messages.push({
                    role: 'system',
                    content: `${label} (${filePath}):\n${excerpt}`
                });
            }
        } catch {
            // Best-effort
        }
    }
    return messages;
}
