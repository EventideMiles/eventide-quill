import { describe, it, expect } from 'vitest';
import { ToolRegistry, DuplicateToolError, executeToolCall } from '../../../src/ai/tools/tool';
import type { Tool, ToolContext } from '../../../src/ai/tools/tool';
import type { ToolCallRequest } from '../../../src/ai/provider';

function makeTool(id: string, opts: Partial<Tool> = {}): Tool {
    return {
        id,
        description: `Tool ${id}`,
        parameters: { type: 'object', properties: {} },
        maxResultTokens: 1000,
        requiresNetwork: false,
        execute: async () => `result from ${id}`,
        ...opts
    };
}

function makeCtx(signal?: AbortSignal): ToolContext {
    return { plugin: {} } as unknown as ToolContext;
    void signal;
}

function makeCall(name: string, args: string = '{}'): ToolCallRequest {
    return { id: 'call_1', name, arguments: args };
}

describe('ToolRegistry', () => {
    describe('register + get', () => {
        it('registers and retrieves a tool by id', () => {
            const reg = new ToolRegistry();
            const tool = makeTool('lookup');
            reg.register(tool);
            expect(reg.get('lookup')).toBe(tool);
        });

        it('returns undefined for an unregistered id', () => {
            const reg = new ToolRegistry();
            expect(reg.get('nonexistent')).toBeUndefined();
        });
    });

    describe('duplicate detection', () => {
        it('throws DuplicateToolError when the same id is registered twice', () => {
            const reg = new ToolRegistry();
            reg.register(makeTool('lookup'));
            expect(() => reg.register(makeTool('lookup'))).toThrow(DuplicateToolError);
        });

        it('the error carries the conflicting tool id', () => {
            const reg = new ToolRegistry();
            reg.register(makeTool('search'));
            try {
                reg.register(makeTool('search'));
                expect.fail('should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(DuplicateToolError);
                expect((err as DuplicateToolError).toolId).toBe('search');
            }
        });
    });

    describe('has', () => {
        it('returns true for registered tools', () => {
            const reg = new ToolRegistry();
            reg.register(makeTool('lookup'));
            expect(reg.has('lookup')).toBe(true);
        });

        it('returns false for unregistered tools', () => {
            const reg = new ToolRegistry();
            expect(reg.has('nonexistent')).toBe(false);
        });
    });

    describe('list', () => {
        it('returns all registered tools', () => {
            const reg = new ToolRegistry();
            reg.register(makeTool('a'));
            reg.register(makeTool('b'));
            expect(reg.list()).toHaveLength(2);
            expect(reg.list().map((t) => t.id).sort()).toEqual(['a', 'b']);
        });

        it('returns empty array for empty registry', () => {
            expect(new ToolRegistry().list()).toEqual([]);
        });
    });

    describe('size', () => {
        it('returns the number of registered tools', () => {
            const reg = new ToolRegistry();
            expect(reg.size).toBe(0);
            reg.register(makeTool('a'));
            reg.register(makeTool('b'));
            expect(reg.size).toBe(2);
        });
    });

    describe('toToolDefinitions', () => {
        it('serializes tools to the provider request-body shape', () => {
            const reg = new ToolRegistry();
            reg.register(makeTool('lookup', { description: 'Look up a value' }));
            const defs = reg.toToolDefinitions();
            expect(defs).toHaveLength(1);
            expect(defs[0]).toEqual({
                name: 'lookup',
                description: 'Look up a value',
                parameters: { type: 'object', properties: {} }
            });
        });

        it('returns empty array for empty registry', () => {
            expect(new ToolRegistry().toToolDefinitions()).toEqual([]);
        });
    });

    describe('estimateTokens', () => {
        it('returns a positive number for a non-empty registry', () => {
            const reg = new ToolRegistry();
            reg.register(makeTool('lookup', { description: 'A tool for looking things up' }));
            expect(reg.estimateTokens()).toBeGreaterThan(0);
        });

        it('returns a small number for an empty registry (JSON overhead)', () => {
            // JSON.stringify([]) is '[]' (2 chars) → ceil(2/4) = 1.
            expect(new ToolRegistry().estimateTokens()).toBe(1);
        });

        it('grows when more tools are added', () => {
            const reg = new ToolRegistry();
            reg.register(makeTool('a'));
            const small = reg.estimateTokens();
            reg.register(makeTool('b'));
            const larger = reg.estimateTokens();
            expect(larger).toBeGreaterThan(small);
        });
    });
});

describe('executeToolCall', () => {
    it('returns an error string for an unregistered tool', async () => {
        const reg = new ToolRegistry();
        const result = await executeToolCall(makeCall('nonexistent'), reg, makeCtx());
        expect(result.text).toContain('not registered');
    });

    it('executes a registered tool and returns its result', async () => {
        const reg = new ToolRegistry();
        reg.register(makeTool('greet', { execute: async () => 'hello' }));
        const result = await executeToolCall(makeCall('greet'), reg, makeCtx());
        expect(result.text).toBe('hello');
    });

    it('parses JSON arguments and passes them to execute', async () => {
        const reg = new ToolRegistry();
        reg.register(
            makeTool('echo', {
                execute: async (args) => `echo: ${typeof args.message === 'string' ? args.message : ''}`
            })
        );
        const result = await executeToolCall(
            makeCall('echo', '{"message":"hi"}'),
            reg,
            makeCtx()
        );
        expect(result.text).toBe('echo: hi');
    });

    it('returns an error for invalid JSON arguments', async () => {
        const reg = new ToolRegistry();
        reg.register(makeTool('test'));
        const result = await executeToolCall(
            makeCall('test', '{invalid json}'),
            reg,
            makeCtx()
        );
        expect(result.text).toContain('invalid JSON');
    });

    it('returns an error when arguments are not an object', async () => {
        const reg = new ToolRegistry();
        reg.register(makeTool('test'));
        const result = await executeToolCall(makeCall('test', '"a string"'), reg, makeCtx());
        expect(result.text).toContain('expected an object');
    });

    it('handles empty arguments string as empty object', async () => {
        const reg = new ToolRegistry();
        reg.register(makeTool('test', { execute: async () => 'ok' }));
        const result = await executeToolCall(makeCall('test', ''), reg, makeCtx());
        expect(result.text).toBe('ok');
    });

    it('normalizes a string result into a ToolResult', async () => {
        const reg = new ToolRegistry();
        reg.register(makeTool('str', { execute: async () => 'plain string' }));
        const result = await executeToolCall(makeCall('str'), reg, makeCtx());
        expect(result.text).toBe('plain string');
        expect(result.images).toBeUndefined();
    });

    it('truncates results exceeding maxResultTokens', async () => {
        const reg = new ToolRegistry();
        reg.register(
            makeTool('long', {
                maxResultTokens: 5, // 5 tokens * 4 chars = 20 chars max
                execute: async () => 'x'.repeat(100)
            })
        );
        const result = await executeToolCall(makeCall('long'), reg, makeCtx());
        expect(result.text.length).toBeLessThan(100);
        expect(result.text).toContain('truncated');
    });

    it('catches tool execution errors and returns them as result text', async () => {
        const reg = new ToolRegistry();
        reg.register(
            makeTool('fail', {
                execute: async () => {
                    throw new Error('boom');
                }
            })
        );
        const result = await executeToolCall(makeCall('fail'), reg, makeCtx());
        expect(result.text).toContain('boom');
        expect(result.text).toContain('Error executing tool');
    });

    it('re-throws on abort signal', async () => {
        const reg = new ToolRegistry();
        reg.register(makeTool('test'));
        const controller = new AbortController();
        controller.abort();
        const ctx = { plugin: {}, signal: controller.signal } as unknown as ToolContext;
        await expect(executeToolCall(makeCall('test'), reg, ctx)).rejects.toThrow();
    });
});

describe('DuplicateToolError', () => {
    it('carries the toolId and a descriptive message', () => {
        const err = new DuplicateToolError('my_tool');
        expect(err.toolId).toBe('my_tool');
        expect(err.message).toContain('my_tool');
        expect(err.name).toBe('DuplicateToolError');
    });

    it('is an Error instance', () => {
        expect(new DuplicateToolError('x')).toBeInstanceOf(Error);
    });
});
