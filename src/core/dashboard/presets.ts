/** A preset configuration for a manuscript type (short story, novel, epic, etc.). */
export interface ManuscriptPreset {
    /** Unique identifier. */
    id: string;
    /** Display label for the preset button. */
    label: string;
    /** Brief description of the word count range. */
    description: string;
    /** Default word count target per chapter. */
    wordCountTarget: number;
    /** Default total word count target. */
    manuscriptTarget: number;
    /** Default target Flesch-Kincaid grade level. */
    targetGradeLevel: number;
}

/**
 * Preset configurations for common manuscript types.
 *
 * Word count ranges are based on industry standards:
 * - Short story: under 7,500 words
 * - Novella: 17,500–40,000 words
 * - Standard novel: 80,000–100,000 words (typical for genre fiction)
 * - Epic: 100,000+ words (typical for epic fantasy, historical)
 * - Web serial: shorter chapters, ongoing publication
 *
 * Grade level targets:
 * - Most adult fiction targets grade 6–8
 * - YA targets grade 5–7
 * - Literary fiction can be higher
 */
export const MANUSCRIPT_PRESETS: ManuscriptPreset[] = [
    {
        id: 'short-story',
        label: 'Short story',
        description: 'Up to ~7,500 words',
        wordCountTarget: 2500,
        manuscriptTarget: 7500,
        targetGradeLevel: 6
    },
    {
        id: 'novella',
        label: 'Novella',
        description: '~17,500–40,000 words',
        wordCountTarget: 3000,
        manuscriptTarget: 30000,
        targetGradeLevel: 7
    },
    {
        id: 'short-novel',
        label: 'Short novel',
        description: '~50,000–80,000 words',
        wordCountTarget: 3500,
        manuscriptTarget: 65000,
        targetGradeLevel: 7
    },
    {
        id: 'standard-novel',
        label: 'Standard novel',
        description: '~80,000–100,000 words',
        wordCountTarget: 4000,
        manuscriptTarget: 90000,
        targetGradeLevel: 8
    },
    {
        id: 'epic-novel',
        label: 'Epic novel',
        description: '100,000+ words',
        wordCountTarget: 5000,
        manuscriptTarget: 120000,
        targetGradeLevel: 9
    },
    {
        id: 'web-serial',
        label: 'Web serial',
        description: 'Short chapters, ongoing',
        wordCountTarget: 2000,
        manuscriptTarget: 100000,
        targetGradeLevel: 6
    }
];
