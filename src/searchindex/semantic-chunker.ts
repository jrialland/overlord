import { encoding_for_model } from 'tiktoken';
import { type ChunkingOptions, type ProcessedChunk, type StructuredContent, createChunkingOptions } from './types';
import { logger } from '../logging';

// Re-export types for external use
export { type ChunkingOptions, type ProcessedChunk, type StructuredContent, createChunkingOptions };

export class SemanticChunker {
  private tokenizer: any;
  private options: Required<ChunkingOptions>;

  constructor(options: ChunkingOptions = {}) {
    this.options = createChunkingOptions(options);

    // Initialize tokenizer
    try {
      this.tokenizer = encoding_for_model('gpt-4');
    } catch (error) {
      logger.warn('Failed to load tiktoken, using fallback tokenizer');
      this.tokenizer = null;
    }
  }

  estimateTokens(text: string): number {
    if (this.tokenizer) {
      return this.tokenizer.encode(text).length;
    } else {
      // Fallback: rough estimation (4 characters per token)
      return Math.floor(text.length / 4);
    }
  }

  async chunkText(text: string, options: ChunkingOptions = {}): Promise<ProcessedChunk[]> {
    const opts = { ...this.options, ...options };

    logger.info(opts, "Starting semantic chunking");

    // Extract base64 images first to prevent splitting them
    const { textWithPlaceholders, images } = this.extractBase64Images(text);
    if (Object.keys(images).length > 0) {
      logger.info(`Found ${Object.keys(images).length} base64 images, replacing with placeholders for chunking`);
    }

    // Pre-process text to identify structural elements
    const structuredContent = this.identifyStructure(textWithPlaceholders, opts);

    // Perform recursive chunking with semantic boundaries
    const chunks = this.recursiveChunk(
      structuredContent.text,
      structuredContent.metadata,
      opts
    );

    // Add overlap between chunks
    const chunksWithOverlap = this.addOverlap(chunks, opts);

    // Restore base64 images in the chunks
    const finalChunks = this.restoreBase64Images(chunksWithOverlap, images);

    logger.info(`Created ${finalChunks.length} semantic chunks`);
    return finalChunks;
  }

  private extractBase64Images(text: string): { textWithPlaceholders: string; images: Record<string, string> } {
    const images: Record<string, string> = {};
    let placeholderCounter = 0;

    // Find base64 images
    const pattern = /data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g;
    let textWithPlaceholders = text;

    let match;
    while ((match = pattern.exec(text)) !== null) {
      const placeholder = `__BASE64_IMAGE_${placeholderCounter}__`;
      images[placeholder] = match[0];
      textWithPlaceholders = textWithPlaceholders.replace(match[0], placeholder);
      placeholderCounter++;
    }

    return { textWithPlaceholders, images };
  }

  private identifyStructure(text: string, options: ChunkingOptions): StructuredContent {
    const metadata = {
      headings: [] as Array<{ line: number; level: number; text: string }>,
      paragraphs: [] as Array<{ line: number; text: string }>,
      lists: [] as Array<{ line: number; text: string }>,
      tables: [] as Array<{ line: number; text: string }>,
      codeBlocks: [] as Array<{ line: number; text: string }>
    };

    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();

      // Identify headings
      if (line.startsWith('#')) {
        const level = line.length - line.replace(/^#+/, '').length;
        metadata.headings.push({
          line: i,
          level,
          text: line.replace(/^#+\s*/, '').trim()
        });
      }

      // Identify code blocks
      else if (line.startsWith('```')) {
        metadata.codeBlocks.push({
          line: i,
          text: line
        });
      }

      // Identify tables
      else if (line.includes('|') && (line.match(/\|/g) || []).length >= 2) {
        metadata.tables.push({
          line: i,
          text: line
        });
      }

      // Identify lists
      else if (/^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
        metadata.lists.push({
          line: i,
          text: line
        });
      }
    }

    return {
      text,
      metadata
    };
  }

  private recursiveChunk(text: string, metadata: any, options: ChunkingOptions): ProcessedChunk[] {
    // Split by headings if preserve_heading_hierarchy is enabled
    if (options.preserveHeadingHierarchy) {
      return this.chunkByHeadings(text, metadata, options);
    } else {
      // Simple sentence-based chunking
      return this.chunkBySentences(text, options);
    }
  }

  private chunkByHeadings(text: string, metadata: any, options: ChunkingOptions): ProcessedChunk[] {
    const chunks: ProcessedChunk[] = [];
    const lines = text.split('\n');

    let currentChunk: string[] = [];
    let currentHeading: string | null = null;
    let chunkIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();

      // Check if this is a heading
      if (line.startsWith('#')) {
        const level = line.length - line.replace(/^#+/, '').length;

        // If we have content and hit a heading at or below split level, create chunk
        if (currentChunk.length > 0 &&
          level <= (options.splitAtHeadingLevel || 2) &&
          currentChunk.join('\n').trim().length > (options.minHeadingChunkSize || 50)) {

          const chunkText = currentChunk.join('\n').trim();
          if (this.estimateTokens(chunkText) >= (options.minTokens || 100)) {
            chunks.push(this.createChunk(chunkText, chunkIndex, currentHeading));
            chunkIndex++;
          }

          currentChunk = [];
        }

        currentHeading = line.replace(/^#+\s*/, '').trim();
      }

      currentChunk.push(line);

      // Check if current chunk exceeds max tokens or characters and force split
      if (currentChunk.length > 0) {
        const chunkText = currentChunk.join('\n');
        const tokenCount = this.estimateTokens(chunkText);

        if (tokenCount > this.options.maxOutputTokens || chunkText.length > 2000) {
          // Force split by sentences
          const sentences = chunkText.split('. ');
          let tempChunk: string[] = [];

          for (const sentence of sentences) {
            tempChunk.push(sentence);
            const tempText = tempChunk.join('. ');
            const tempTokens = this.estimateTokens(tempText);

            if (tempTokens > this.options.maxOutputTokens || tempText.length > 2000) {
              // Create chunk from tempChunk without last sentence
              if (tempChunk.length > 1) {
                const finalText = tempChunk.slice(0, -1).join('. ');
                if (this.estimateTokens(finalText) >= (options.minTokens || 100)) {
                  chunks.push(this.createChunk(finalText, chunkIndex, currentHeading));
                  chunkIndex++;
                }
              }

              // Start new chunk with last sentence
              tempChunk = [tempChunk[tempChunk.length - 1]!]!;
            }
          }

          // Update currentChunk with remaining content
          currentChunk = tempChunk.length > 0 ? [tempChunk.join('. ')] : [];
        }
      }
    }

    // Add final chunk
    if (currentChunk.length > 0) {
      const chunkText = currentChunk.join('\n').trim();
      if (this.estimateTokens(chunkText) >= (options.minTokens || 100)) {
        chunks.push(this.createChunk(chunkText, chunkIndex, currentHeading));
      }
    }

    return chunks;
  }

  private chunkBySentences(text: string, options: ChunkingOptions): ProcessedChunk[] {
    const chunks: ProcessedChunk[] = [];

    // Split into sentences
    const sentences = text.split(/(?<=[.!?])\s+/);

    let currentChunk: string[] = [];
    let chunkIndex = 0;

    for (const sentence of sentences) {
      currentChunk.push(sentence);

      // Check if chunk is large enough
      const chunkText = currentChunk.join(' ');
      const tokenCount = this.estimateTokens(chunkText);

      if (tokenCount >= this.options.maxOutputTokens || chunkText.length >= 2000) {
        chunks.push(this.createChunk(chunkText, chunkIndex));
        chunkIndex++;
        currentChunk = [];
      }
    }

    // Add final chunk
    if (currentChunk.length > 0) {
      const chunkText = currentChunk.join(' ');
      if (this.estimateTokens(chunkText) >= (options.minTokens || 100)) {
        chunks.push(this.createChunk(chunkText, chunkIndex));
      }
    }

    return chunks;
  }

  private createChunk(text: string, chunkIndex: number, heading?: string | null): ProcessedChunk {
    return {
      content: text,
      chunkIndex,
      tokenCount: this.estimateTokens(text),
      metadata: {
        heading: heading || undefined,
        headingHierarchy: heading || undefined,
        containsCode: text.includes('```'),
        containsLinks: text.includes('[') && text.includes(']('),
        containsImages: text.includes('!['),
        containsTables: text.includes('|') && (text.match(/\|/g) || []).length >= 4,
        containsLists: /^\s*[-*+]\s/.test(text) || /^\s*\d+\.\s/.test(text),
        length: text.length,
        createdAt: new Date().toISOString()
      }
    };
  }

  private addOverlap(chunks: ProcessedChunk[], options: ChunkingOptions): ProcessedChunk[] {
    if (chunks.length <= 1) {
      return chunks;
    }

    const overlapPercentage = options.overlapPercentage || 0.20;
    const overlappedChunks: ProcessedChunk[] = [];

    for (let i = 0; i < chunks.length; i++) {
      let content = chunks[i]!.content;

      // Add overlap from previous chunk
      if (i > 0 && overlapPercentage > 0) {
        const prevChunk = chunks[i - 1]!;
        const prevContent = prevChunk.content;

        // Calculate overlap size
        const overlapTokens = Math.floor(prevContent.split(' ').length * overlapPercentage);
        const overlapWords = prevContent.split(' ').slice(-overlapTokens);

        if (overlapWords.length > 0) {
          content = overlapWords.join(' ') + '\n\n' + content;
        }
      }

      overlappedChunks.push({
        ...chunks[i]!,
        content,
        tokenCount: this.estimateTokens(content)
      });
    }

    return overlappedChunks;
  }

  private restoreBase64Images(chunks: ProcessedChunk[], images: Record<string, string>): ProcessedChunk[] {
    return chunks.map(chunk => {
      let content = chunk.content;
      for (const [placeholder, imageData] of Object.entries(images)) {
        content = content.replace(placeholder, imageData);
      }
      return {
        ...chunk,
        content
      };
    });
  }
}