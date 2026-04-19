export interface ChunkingOptions {
  maxOutputTokens?: number;
  minTokens?: number;
  overlapPercentage?: number;
  preserveHeadingHierarchy?: boolean;
  splitAtHeadingLevel?: number;
  preserveFrontmatter?: boolean;
  extractCodeSeparately?: boolean;
  minHeadingChunkSize?: number;
  documentType?: string;
  preserveStructure?: boolean;
  preserveTables?: boolean;
  preserveLists?: boolean;
  preserveCodeBlocks?: boolean;
}

export interface ChunkMetadata {
  heading?: string;
  headingHierarchy?: string;
  containsCode?: boolean;
  containsLinks?: boolean;
  containsImages?: boolean;
  containsTables?: boolean;
  containsLists?: boolean;
  sourceUrl?: string;
  documentType?: string;
  length: number;
  createdAt: string;
}

export interface ProcessedChunk {
  content: string;
  chunkIndex: number;
  tokenCount: number;
  metadata: ChunkMetadata;
}

export interface StructuredContent {
  text: string;
  metadata: {
    headings: Array<{ line: number; level: number; text: string }>;
    paragraphs: Array<{ line: number; text: string }>;
    lists: Array<{ line: number; text: string }>;
    tables: Array<{ line: number; text: string }>;
    codeBlocks: Array<{ line: number; text: string }>;
  };
}

/**
 * Creates default chunking options with optional overrides
 */
export const createChunkingOptions = (overrides: Partial<ChunkingOptions> = {}): Required<ChunkingOptions> => ({
  maxOutputTokens: 500, // ~2000 characters (500 tokens * 4 chars/token)
  minTokens: 50,
  overlapPercentage: 0.20,
  preserveHeadingHierarchy: true,
  splitAtHeadingLevel: 2,
  preserveFrontmatter: true,
  extractCodeSeparately: true,
  minHeadingChunkSize: 50,
  documentType: 'text',
  preserveStructure: true,
  preserveTables: true,
  preserveLists: true,
  preserveCodeBlocks: true,
  ...overrides
});

/**
 * Transforms ProcessedChunk to NewChunk format for database storage
 */
export const transformChunkForDatabase = (chunk: ProcessedChunk): any => ({
  content: chunk.content,
  chunkIndex: chunk.chunkIndex,
  tokenCount: chunk.tokenCount,
  sourceUrl: chunk.metadata.sourceUrl || null,
  documentType: chunk.metadata.documentType || 'markdown',
  heading: chunk.metadata.heading || null,
  headingHierarchy: chunk.metadata.headingHierarchy || null,
  containsCode: chunk.metadata.containsCode || false,
  containsLinks: chunk.metadata.containsLinks || false,
  containsImages: chunk.metadata.containsImages || false,
  containsTables: chunk.metadata.containsTables || false,
  containsLists: chunk.metadata.containsLists || false,
  length: chunk.metadata.length,
  createdAt: new Date(chunk.metadata.createdAt),
  updatedAt: new Date()
});