import { Notice } from 'obsidian';
import type { Tool } from './tool';

/**
 * Add a world-building rule to the writer's settings. The rule is appended to
 * `reviewWorldRules` and persisted immediately, so future edits in this and
 * future sessions will follow it.
 *
 * Use this when the writer mentions a world-specific detail in conversation
 * that should be remembered for all future prose edits — vocabulary, physical
 * traits, magic system rules, setting details, etc.
 *
 * Example: the writer says "in my world swords are called blades" ->
 * call add_world_rule(rule: "Swords are called 'blades' regardless of shape.")
 */
export const addWorldRuleTool: Tool = {
    id: 'add_world_rule',
    description:
        'Add a world-building rule to the writer\u2019s persistent settings. ' +
        'The rule will be followed in all future prose edits. Use this when ' +
        'the writer mentions a world-specific detail that should be remembered ' +
        '(vocabulary, physical traits, magic rules, setting details). ' +
        'Example: add_world_rule(rule: "Swords are called blades regardless of shape.")',
    parameters: {
        type: 'object',
        properties: {
            rule: {
                type: 'string',
                description:
                    'The rule to add, phrased as a clear instruction. ' +
                    'Be specific about what to do, not just what to avoid. ' +
                    'Example: "Swords are called blades regardless of shape in this world."'
            }
        },
        required: ['rule']
    },
    maxResultTokens: 100,
    requiresNetwork: false,

    async execute(args: Record<string, unknown>, ctx): Promise<string> {
        const rule = typeof args.rule === 'string' ? args.rule.trim() : '';
        if (!rule) return 'Error: "rule" is required.';

        const { plugin } = ctx;
        const current = plugin.settings.reviewWorldRules?.trim() ?? '';
        const updated = current ? `${current}\n${rule}` : rule;
        plugin.settings.reviewWorldRules = updated;
        await plugin.saveSettings();

        new Notice('World rule added.');
        return (
            `Rule added to world rules: "${rule.slice(0, 80)}${rule.length > 80 ? '...' : ''}". ` +
            'This rule will be followed in all future prose edits.'
        );
    }
};
