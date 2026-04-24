import fs, { access } from "fs";
import path from "path";
import { createPatch, applyPatch } from "diff";
import { filesize } from "filesize";
import type { ToolSet, Tool, ImagePart } from "ai";
import { z } from "zod";
import { detectFileType } from "./detect-file-type";
import { glob } from "glob";
import { minimatch } from "minimatch";
import { getFileIcon } from "./fileicons";
import { normalizeFsPath, toGlobPattern } from "../path-utils";

const fsp = fs.promises;

export class FileSystemTools {

    readonly maxChars = 128000;

    readonly maxLines = 500;

    readonly listDirMaxDepth = 5;

    readonly skippedDirs = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".coverage", "htmlcov"]);

    /**
     * Creates a filesystem tool facade scoped to the workspace and optional allowed subdirectories.
     */
    constructor(private workspace: string, private allowedDirs: string[] = []) {
        this.workspace = path.resolve(workspace);
        this.allowedDirs = allowedDirs.map((dir) =>
            path.resolve(path.isAbsolute(dir) ? dir : path.join(this.workspace, dir)),
        );
    }

    /**
     * Returns true when candidatePath is the same as baseDir or a descendant of baseDir.
     * Uses path.relative to avoid prefix-based bypasses (e.g. "workspace-evil").
     */
    private isPathWithin(baseDir: string, candidatePath: string): boolean {
        const relative = path.relative(baseDir, candidatePath);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }

    /**
     * Resolves a user path and enforces workspace/allowedDirs containment checks.
     */
    private resolvePath(p: string): string {
        const normalizedPath = path.resolve(path.isAbsolute(p) ? p : path.join(this.workspace, p));

        if (!this.isPathWithin(this.workspace, normalizedPath)) {
            throw new Error(`Access to path is not allowed: ${normalizedPath}`);
        }

        if (this.allowedDirs.length > 0 && !this.allowedDirs.some((dir) => this.isPathWithin(dir, normalizedPath))) {
            throw new Error(`Access to path is not allowed: ${normalizedPath}`);
        }

        return normalizedPath;
    }

    /**
     * Recursively prints an ASCII tree of a directory
     * @param {string} dirPath - Directory path to scan
     * @param {string} prefix - Prefix for tree formatting
     * @param {boolean} recursive - Whether to recursively print 
     * @param {string | undefined} globPattern - Optional glob pattern to filter files
     * @param {boolean} includeFileSizes - Whether to include file sizes in the output
     * @param {number} depth - Current depth of the recursion
     */
    private async printTree(dirPath: string, prefix: string = "", recursive: boolean = false, globPattern: string | undefined = undefined, includeFileSizes: boolean = false, depth: number = 0): Promise<string> {
        let result = "";
        const items = await fsp.readdir(dirPath, { withFileTypes: true });
        // Sort: directories first, then files
        items.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
        });
        for (const [index, item] of items.entries()) {

            if (globPattern && !minimatch(item.name, globPattern)) {
                continue;
            }

            const isDirectory = item.isDirectory();
            const isLast = index === items.length - 1;
            const connector = isLast ? "└─" : "├─";
            const shouldSkip = item.isDirectory() && (this.skippedDirs.has(item.name) || depth >= this.listDirMaxDepth);
            const name = item.name.includes(" ") ? `"${item.name}"` : item.name;
            const icon = item.isDirectory() ? "📁" : getFileIcon(item.name);
            const size = includeFileSizes && !isDirectory ? ` (${filesize((await fsp.stat(path.join(dirPath, item.name))).size)})` : "";

            result += `${prefix}${connector}${icon} ${name}${size}${shouldSkip ? " [LISTING_SKIPPED]" : ""}\n`;

            if (isDirectory && recursive && !shouldSkip) {
                const newPrefix = prefix + (isLast ? "  " : "│ ");
                result += await this.printTree(path.join(dirPath, item.name), newPrefix, recursive, globPattern, includeFileSizes, depth + 1);
            }
        }
        return result;
    }

    /**
     * Lists the content of a directory in an ASCII tree format.
     * @param dir - Directory path to list. If not provided, the workspace root will be listed.
     * @param recursive - Whether to recursively list subdirectories.
     * @param includeFileSizes - Whether to include file sizes in the output.
     * @returns A string representing the directory tree.
     */
    async listDir(
        dir: string | undefined = undefined,
        recursive: boolean = false,
        globPattern: string | undefined = undefined,
        includeFileSizes: boolean = false
    ): Promise<string> {
        const targetDir = dir ? this.resolvePath(dir) : this.workspace;
        let stats: fs.Stats;
        try {
            stats = await fsp.stat(targetDir);
        } catch {
            throw new Error(`Directory not found: ${targetDir}`);
        }

        if (!stats.isDirectory()) {
            throw new Error(`Directory not found: ${targetDir}`);
        }
        return `📁 ${targetDir}\n` + await this.printTree(targetDir, "", recursive, globPattern, includeFileSizes, 0);
    }

    /**
     * Reads an image file and returns an AI SDK-compatible image part payload.
     */
    async viewImageFile(filePath: string): Promise<ImagePart[]> {
        const resolvedPath = this.resolvePath(filePath);
        let stats: fs.Stats;
        try {
            stats = await fsp.stat(resolvedPath);
        } catch {
            throw new Error(`File not found: ${resolvedPath}`);
        }

        if (!stats.isFile()) {
            throw new Error(`File not found: ${resolvedPath}`);
        }
        const ext = path.extname(resolvedPath).toLowerCase();
        const supportedImageTypes = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg"]);
        if (!supportedImageTypes.has(ext)) {
            throw new Error(`Unsupported image type: ${ext}`);
        }
        const fileContent = await fsp.readFile(resolvedPath);
        const base64Content = fileContent.toString("base64");
        const mimeType = ext === ".svg" ? "image/svg+xml" : `image/${ext.slice(1)}`;
        return [
            {
                "type": "image",
                // AI SDK image part format: `image` contains raw base64 payload without data URL wrapper.
                "image": base64Content,
                // Explicit media type helps providers interpret the image bytes consistently.
                "mediaType": mimeType
            }
        ];
    }

    /**
     * Reads lines from a text file using 1-based line numbering.
     * @param filePath
     * @param lineOffset - 1-based start line number.
     * @param lineCount
     * @param includeLineNumbers - Whether to include line numbers in the output.
     */
    async readTextFile(filePath: string, lineOffset: number = 1, lineCount: number = this.maxLines, includeLineNumbers: boolean = true): Promise<string> {
        const resolvedPath = this.resolvePath(filePath);
        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
            throw new Error(`File not found: ${resolvedPath}`);
        }
        const fileType = await detectFileType(resolvedPath);
        if (!fileType.isText) {
            throw new Error(`File is not a text file: ${resolvedPath}.`);
        }
        if (lineOffset < 1 || lineCount <= 0) {
            throw new Error(`Invalid lineOffset or lineCount. lineOffset must be >= 1 and lineCount must be > 0.`);
        }
        if (lineCount > this.maxLines) {
            throw new Error(`lineCount cannot exceed ${this.maxLines}.`);
        }
        const fileContent = await fsp.readFile(resolvedPath, "utf-8");
        const lines = fileContent.split(/\r?\n/);
        const startIndex = lineOffset - 1;
        const selectedLines = lines.slice(startIndex, startIndex + lineCount);
        if (selectedLines.length === 0) {
            return "(no lines to read)";
        }
        if (includeLineNumbers) {
            for (let i = 0; i < selectedLines.length; i++) {
                selectedLines[i] = `${lineOffset + i}: ${selectedLines[i]}`;
            }
        }
        return selectedLines.join("\n");
    }

    async replaceTextInFile(filePath: string, oldText: string, newText: string, allOccurrences: boolean = false): Promise<void> {
        const resolvedPath = this.resolvePath(filePath);
        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
            throw new Error(`File not found: ${resolvedPath}`);
        }
        const fileType = await detectFileType(resolvedPath);
        if (!fileType.isText) {
            throw new Error(`File is not a text file: ${resolvedPath}.`);
        }
        let fileContent = await fsp.readFile(resolvedPath, "utf-8");
        if (allOccurrences) {
            fileContent = fileContent.split(oldText).join(newText);
        } else {
            fileContent = fileContent.replace(oldText, newText);
        }
        await fsp.writeFile(resolvedPath, fileContent, "utf-8");
    }

    /**
     * Deletes a file or directory recursively.
     */
    async delete(fileOrDirPath: string): Promise<void> {
        const resolvedPath = this.resolvePath(fileOrDirPath);
        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`File or directory not found: ${resolvedPath}`);
        }
        const stats = await fsp.stat(resolvedPath);
        if (stats.isDirectory()) {
            await fsp.rm(resolvedPath, { recursive: true, force: true });
        } else {
            await fsp.unlink(resolvedPath);
        }
    }

    /**
     * Creates a unified diff between two text files. Both files must exist and be text files, otherwise an error is thrown.
     * @param filePath1 source file
     * @param filePath2 target file
     * @returns an unified diff that contains the modifications from source to target
     */
    async createUnifiedDiffFiles(filePath1: string, filePath2: string): Promise<string> {
        const resolvedPath1 = this.resolvePath(filePath1);
        const resolvedPath2 = this.resolvePath(filePath2);
        if (!fs.existsSync(resolvedPath1) || !fs.statSync(resolvedPath1).isFile()) {
            throw new Error(`File not found: ${resolvedPath1}`);
        }
        if (!fs.existsSync(resolvedPath2) || !fs.statSync(resolvedPath2).isFile()) {
            throw new Error(`File not found: ${resolvedPath2}`);
        }
        const fileType1 = await detectFileType(resolvedPath1);
        const fileType2 = await detectFileType(resolvedPath2);
        if (!fileType1.isText) {
            throw new Error(`File is not a text file: ${resolvedPath1}.`);
        }
        if (!fileType2.isText) {
            throw new Error(`File is not a text file: ${resolvedPath2}.`);
        }
        const content1 = await fsp.readFile(resolvedPath1, "utf-8");
        const content2 = await fsp.readFile(resolvedPath2, "utf-8");
        const diff = createPatch(path.basename(resolvedPath1), content1, content2);
        return diff;
    }

    /**
     * Applies a unified diff patch to a text file. The file must exist and be a text file, otherwise an error is thrown. The patch must be a valid unified diff, otherwise an error is thrown.
     * @param filePath The file to apply the patch on
     * @param patch content of the patch
     */
    async applyUnifiedDiffToFile(filePath: string, patch: string): Promise<void> {
        const resolvedPath = this.resolvePath(filePath);
        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
            throw new Error(`File not found: ${resolvedPath}`);
        }
        const fileType = await detectFileType(resolvedPath);
        if (!fileType.isText) {
            throw new Error(`File is not a text file: ${resolvedPath}.`);
        }
        const content = await fsp.readFile(resolvedPath, "utf-8");
        const patchedContent = applyPatch(content, patch);
        if (patchedContent === false) {
            throw new Error(`Failed to apply patch to file: ${resolvedPath}.`);
        }
        await fsp.writeFile(resolvedPath, patchedContent, "utf-8");
    }


    /**
     * Write text to a file, optionally appending to existing content. Creates the file if it doesn't exist.
     * @param filePath 
     * @param text 
     * @param append 
     * @returns 
     */
    async writeTextToFile(filePath: string, text: string, append: boolean = false): Promise<string> {
        const resolvedPath = this.resolvePath(filePath);
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) {
            await fsp.mkdir(dir, { recursive: true });
        }
        if (append && fs.existsSync(resolvedPath)) {
            await fsp.appendFile(resolvedPath, text, "utf-8");
            return `Appended ${text.length} characters to ${resolvedPath}`;
        } else {
            await fsp.writeFile(resolvedPath, text, "utf-8");
            return `Wrote ${text.length} characters to ${resolvedPath}`;
        }
    }

    /**
     * Move or rename a file or directory. If the target path already exists, it will be overwritten. If the target directory does not exist, it will be created.
     * @param sourcePath The path of the file or directory to move or rename
     * @param targetPath The target path where the file or directory should be moved or renamed
     */
    async moveFileOrDir(sourcePath: string, targetPath: string): Promise<void> {
        const resolvedSourcePath = this.resolvePath(sourcePath);
        const resolvedTargetPath = this.resolvePath(targetPath);
        if (!fs.existsSync(resolvedSourcePath)) {
            throw new Error(`Source file or directory not found: ${resolvedSourcePath}`);
        }
        const targetDir = path.dirname(resolvedTargetPath);
        if (!fs.existsSync(targetDir)) {
            await fsp.mkdir(targetDir, { recursive: true });
        }
        await fsp.rename(resolvedSourcePath, resolvedTargetPath);
    }

    /**
     * Finds files matching a glob pattern under an optional base directory.
     */
    async findFiles(baseDir: string | undefined = undefined, globPattern: string): Promise<string> {
        if (!globPattern) {
            throw new Error("globPattern is required");
        }
        if (!baseDir) {
            baseDir = this.workspace;
        }
        if (path.isAbsolute(baseDir)) {
            // check that basedir is a child of workspace
            const relative = path.relative(this.workspace, baseDir);
            if (relative.startsWith("..")) {
                throw new Error(`Base directory must be within the workspace. Invalid baseDir: ${baseDir}`);
            }
        } else {
            baseDir = path.join(this.workspace, baseDir);
        }
        const resolvedPattern = toGlobPattern(path.join(baseDir, globPattern));
        const files = await glob(resolvedPattern);
        return files.map((filePath) => normalizeFsPath(filePath)).join("\n");
    }

    /**
     * Get informations about a file, or the number of files in a directory. If the path is a file, the output will include the file size, the file type (binary or text), and if it's a text file, a preview of the content. If the path is a directory, the output will include the number of files and subdirectories it contains.
     * @param filePath 
     */
    async getFileInfo(filePath: string): Promise<string> {
        const resolvedPath = this.resolvePath(filePath);
        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`File not found: ${resolvedPath}`);
        }
        if (fs.statSync(resolvedPath).isDirectory()) {
            const stats = fs.statSync(resolvedPath);
            const items = fs.readdirSync(resolvedPath);
            const fileCount = items.filter(item => fs.statSync(path.join(resolvedPath, item)).isFile()).length;
            const dirCount = items.filter(item => fs.statSync(path.join(resolvedPath, item)).isDirectory()).length;
            return JSON.stringify({
                name: path.basename(resolvedPath) + '/',
                type: "directory",
                creationTime: stats.birthtime,
                modificationTime: stats.mtime,
                accessTime: stats.atime,
                permissions: (stats.mode & 0o777).toString(8),
                files: fileCount,
                directories: dirCount
            });
        } else {
            const stats = fs.statSync(resolvedPath);
            const fileType = await detectFileType(resolvedPath);
            const info = {
                name: path.basename(resolvedPath),
                type: "file",
                size: stats.size,
                humanSize: filesize(stats.size),
                creationTime: stats.birthtime,
                modificationTime: stats.mtime,
                accessTime: stats.atime,
                permissions: (stats.mode & 0o777).toString(8),
                isText: fileType.isText,
                mimeType: fileType.mimeType || "application/octet-stream",
                preview: fileType.isText ? await this.readTextFile(resolvedPath, 1, 10, false) : undefined
            };
            return JSON.stringify(info);
        }
    }


    /**
     * @returns The toolSet of all the tools that this object exposes
     */
    getToolSet(allowWriteOperations: boolean = true): ToolSet {
        const toolset: ToolSet = {
            "ListDir": {
                description: "List the content of a directory in an ASCII tree format. Optionally provide a relative or absolute path to list a specific directory, otherwise the workspace root will be listed.",
                inputSchema: z.object({
                    dir: z.string().optional(),
                    recursive: z.boolean().optional(),
                    globPattern: z.string().optional(),
                    includeFileSizes: z.boolean().optional()
                }),
                execute: async ({ dir, recursive, globPattern, includeFileSizes }) => this.listDir(dir, recursive, globPattern, includeFileSizes)
            } as Tool,
            "ViewImage": {
                description: "Let the model 'view' an image file",
                inputSchema: z.object({
                    file_path: z.string()
                }),
                execute: async ({ file_path }) => this.viewImageFile(file_path)
            } as Tool,
            "ReadFile": {
                description: "Read a portion of a text file, with optional line numbers. Provide a relative or absolute file path, and optionally a 1-based line offset and line count to read a specific portion of the file.",
                inputSchema: z.object({
                    file_path: z.string(),
                    line_offset: z.number().optional(),
                    line_count: z.number().optional(),
                    include_line_numbers: z.boolean().optional()
                }),
                execute: async ({ file_path, line_offset, line_count, include_line_numbers }) => this.readTextFile(file_path, line_offset, line_count, include_line_numbers)
            } as Tool,
            "WriteFile": {
                description: "Write text to a file, optionally appending to existing content. Provide a relative or absolute file path, the text to write, and whether to append or overwrite existing content.",
                inputSchema: z.object({
                    file_path: z.string(),
                    text: z.string(),
                    append: z.boolean().optional()
                }),
                execute: async ({ file_path, text, append }) => this.writeTextToFile(file_path, text, append)
            } as Tool,
            "DeleteFileOrDir": {
                description: "Delete a file or directory. Provide a relative or absolute path to the file or directory to delete.",
                inputSchema: z.object({
                    file_or_dir_path: z.string()
                }),
                execute: async ({ file_or_dir_path }) => this.delete(file_or_dir_path)
            } as Tool,
            "CreateUnifiedDiff": {
                description: "Creates a unified diff between two text files.",
                inputSchema: z.object({
                    file_path_1: z.string(),
                    file_path_2: z.string()
                }),
                execute: async ({ file_path_1, file_path_2 }) => this.createUnifiedDiffFiles(file_path_1, file_path_2)
            } as Tool,
            "ApplyUnifiedDiff": {
                description: "Applies a unified diff patch to a text file.",
                inputSchema: z.object({
                    file_path: z.string(),
                    patch: z.string()
                }),
                execute: async ({ file_path, patch }) => this.applyUnifiedDiffToFile(file_path, patch)
            } as Tool,
            "Move": {
                description: "Move or rename a file or directory.",
                inputSchema: z.object({
                    source_path: z.string(),
                    target_path: z.string()
                }),
                execute: async ({ source_path, target_path }) => this.moveFileOrDir(source_path, target_path)
            } as Tool,
            "FindFiles": {
                description: "Find files matching a glob pattern.",
                inputSchema: z.object({
                    base_dir: z.string().optional(),
                    glob_pattern: z.string()
                }),
                execute: async ({ base_dir, glob_pattern }) => this.findFiles(base_dir, glob_pattern)
            } as Tool,
            "GetFileInfo": {
                description: "Get detailed information about a file.",
                inputSchema: z.object({
                    file_path: z.string()
                }),
                execute: async ({ file_path }) => this.getFileInfo(file_path)
            } as Tool
        } as ToolSet;

        const writeOperations = ["WriteFile", "DeleteFileOrDir", "Move", "ApplyUnifiedDiff"];
        if (!allowWriteOperations) {
            for (const op of writeOperations) {
                delete toolset[op];
            }
        }

        return toolset;
    }
}