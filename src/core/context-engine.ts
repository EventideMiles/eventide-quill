export { extractAllEntities as extractNames, extractAllEntities } from './context-engine/entity-extractor';
export { gatherVaultContext } from './context-engine/context-assembler';
export { assembleContext, compactContext } from './context-engine/context-assembler';
export { ContextCache } from './context-engine/context-cache';
export type {
    ContextAssembly,
    ContextAssemblyOptions,
    ExtractedEntity,
    EntityType,
    VoiceMarker,
    ContextItem
} from './context-engine/types';
export { extractCharacters, extractLocations, extractPlotThreads } from './context-engine/entity-extractor';
export { analyzeVoice } from './context-engine/voice-analyzer';
