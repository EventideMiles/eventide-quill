/** The narrative voice presets available for transformation generation. */
export type NarrativeVoicePreset =
    | 'third-limited'
    | 'third-multiple'
    | 'third-omniscient'
    | 'first-person'
    | 'second-person'
    | 'custom';

export interface NarrativeVoiceDefinition {
    id: NarrativeVoicePreset;
    label: string;
    pov: string;
    tense: string;
    rules: string[];
}

/**
 * Array of all available narrative voice presets.
 * Each entry defines an id, label, pov, tense, and an array of style rules
 * used by the transformation system to constrain AI-generated prose.
 * The first entry is used as the fallback default.
 */
export const NARRATIVE_VOICE_PRESETS: NarrativeVoiceDefinition[] = [
    {
        id: 'third-limited',
        label: 'Third Person Limited',
        pov: 'Single character per scene',
        tense: 'Past',
        rules: [
            "Confined to the current viewpoint character's senses. Describe only what they see, hear, smell, touch, and think.",
            'Do not reveal thoughts or feelings of other characters unless the POV character witnesses them.',
            'No foreknowledge. The character does not know the future.',
            'Describe the world only as the POV character perceives it.',
            "Characters only know what they've experienced or been told. They can be wrong.",
            'No head-hopping within a scene.'
        ]
    },
    {
        id: 'third-multiple',
        label: 'Third Person Multiple',
        pov: 'Multiple characters across scenes',
        tense: 'Past',
        rules: [
            'Confined to one viewpoint character per scene. Switch POV across scene breaks (***).',
            'Do not reveal thoughts or feelings of other characters unless the current POV character witnesses them.',
            'No foreknowledge. The character does not know the future.',
            'Describe the world only as the current POV character perceives it.',
            "Characters only know what they've experienced or been told. They can be wrong.",
            'No head-hopping within a scene.'
        ]
    },
    {
        id: 'third-omniscient',
        label: 'Third Person Omniscient',
        pov: 'All-seeing narrator',
        tense: 'Past',
        rules: [
            'The narrator knows everything: thoughts, feelings, and motives of all characters.',
            'May reveal future events, background, or context the characters themselves lack.',
            "Can describe any character's inner world at any time.",
            'Head-hopping is permitted and natural in this mode.'
        ]
    },
    {
        id: 'first-person',
        label: 'First Person',
        pov: 'Protagonist only',
        tense: 'Past',
        rules: [
            "Everything is filtered through the narrator's voice, opinions, and limited knowledge.",
            'Only describe what the narrator sees, hears, smells, touches, thinks, and remembers.',
            'The narrator can be unreliable — they may misremember, lie to themselves, or misinterpret events.',
            'No omniscience. Do not reveal anything the narrator does not know.',
            'No head-hopping. Everything is from one consciousness.'
        ]
    },
    {
        id: 'second-person',
        label: 'Second Person',
        pov: 'Reader as character',
        tense: 'Present',
        rules: [
            'Use "you" throughout. The reader is the protagonist.',
            "Confined to the reader-character's immediate experience: what they see, hear, feel, and do.",
            'Subjective and immediate. No distance or summary.',
            'Present tense keeps the action immediate.'
        ]
    },
    {
        id: 'custom',
        label: 'Custom',
        pov: 'User-defined',
        tense: 'User-defined',
        rules: ['Follow the narrative voice specified by the user. Match its tense, POV, and knowledge rules exactly.']
    }
];
