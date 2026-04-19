import { NullTopic, Topic } from "../bus/index";
import fs from "fs";
import path from "path";
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'
import { type EmbeddingModel, embed } from "ai";
import { createEmbeddingModel, getEmbeddingModelVectorLength } from "../agent/providers";
import { SemanticChunker } from "./semantic-chunker";
import { file } from "bun";

interface IndexUpdateEvent {
    workspace: string;
    filePath: string;
}
    
interface ReindexProgressEvent {
    workspace: string;
    progress: number;
}

type IndexEvent = IndexUpdateEvent | ReindexProgressEvent;

interface SearchHit {
    filePath: string;
    fragment: string;
    score: number;
}

export class DocumentsIndex {

    pg: PGlite;

    dataDir:string;

    embeddingModel: EmbeddingModel ;

    vectorLength: number;

    constructor(
        private workspace: string,
        private embeddingModelName: string,
        private modelConfig?: Record<string, unknown>,
        private updateIndexTopic: Topic<IndexEvent> = NullTopic
    ) {
            this.dataDir = path.join(workspace, ".overlord", "index");
    }

    private normalizeFilePath(filePath: string): string {
        let relativePath = path.relative(this.workspace, filePath);
        // Ensure direct path : no './' or '../' segments, and use forward slashes for consistency across platforms
        relativePath = path.normalize(relativePath).split(path.sep).join(path.posix.sep);
        return relativePath;
    }

    async initialize() {

        this.embeddingModel = await createEmbeddingModel(this.embeddingModelName, this.modelConfig);

        this.vectorLength = await getEmbeddingModelVectorLength(this.embeddingModel);
    
        this.pg = await PGlite.create(this.dataDir, {
            extensions: {
                vector
            }
        });

        await this.pg.exec("CREATE EXTENSION IF NOT EXISTS vector;");

        await this.pg.exec(`CREATE TABLE IF NOT EXISTS file_index (
            id SERIAL PRIMARY KEY,
            file_path TEXT UNIQUE
        );`);

        await this.pg.exec(`CREATE TABLE IF NOT EXISTS file_embeddings (
            file_id INTEGER PRIMARY KEY,
            fragment text,
            embedding vector(${this.vectorLength}),
            FOREIGN KEY (file_id) REFERENCES file_index(id) ON DELETE CASCADE
        );`);
    }

    private async deleteIndex(filePath: string) {
        await this.pg.exec(`DELETE FROM file_index WHERE file_path = ?;`, [filePath]);
    }

    private async getEmbedding(text: string): Promise<number[]> {
        const embeddingResult = await embed({
            model: this.embeddingModel, value: text
        });
        return embeddingResult.embedding;
    }

    private async embedAndStore(filePath: string) {
        filePath = this.normalizeFilePath(filePath);
        const chunker = new SemanticChunker({
            maxOutputTokens: 500,
            overlapPercentage: 0.20,
            preserveHeadingHierarchy: true,
        });
        const content = await fs.promises.readFile(filePath, "utf-8");
        const chunks = await chunker.chunkText(content);
        let fileId: number | null = null;
        for(const chunk of chunks) {
            const embedding = await this.getEmbedding(chunk.content);
            if(fileId === null) {
                const { rows } = await this.pg.exec(`INSERT INTO file_index (file_path) VALUES (?) ON CONFLICT (file_path) DO UPDATE SET file_path = EXCLUDED.file_path RETURNING id;`, [filePath]);
                fileId = rows[0].id;
            }
            await this.pg.exec(`INSERT INTO file_embeddings (file_id, fragment, embedding) VALUES (?, ?, ?);`, [fileId, chunk.content, embedding]);
        }
    }

    async onFileChange(filePath: string) {
        filePath = this.normalizeFilePath(filePath);
        await this.deleteIndex(filePath);
        await this.embedAndStore(filePath);
        await this.updateIndexTopic.publish({ workspace: this.workspace, filePath });
    }

    async rebuildIndex() {
        // -> delete all the existing index data
        await this.pg.exec(`DELETE FROM file_index;`);

        // glob the entire workspace, avoid files that start with ., known large junk directories like node_modules, .git, etc, and binary files
        // keep only files that are readable = text files

        // for each file, embed and store in the database, and publish progress events

    }

    async search(query: string, topK: number = 5): Promise<SearchHit[]> {
        const queryEmbedding = await this.getEmbedding(query);
        const { rows } = await this.pg.exec(`SELECT fi.file_path, fe.embedding <=> ? AS score, fe.fragment
            FROM file_embeddings fe
            JOIN file_index fi ON fe.file_id = fi.id
            ORDER BY fe.embedding <=> ?
            LIMIT ?;`, [queryEmbedding, queryEmbedding, topK]);
        return rows.map((row: any) => ({
            filePath: row.file_path,
            fragment: row.fragment,
            score: row.score
        }));
    }

}