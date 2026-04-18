import path from "path";

/**
 * Normalize a filesystem path for the current OS separator semantics.
 */
export function normalizeFsPath(inputPath: string): string {
    return path.normalize(inputPath);
}

/**
 * Convert a filesystem path into a POSIX-style glob pattern.
 * Glob libraries generally expect '/' separators even on Windows.
 */
export function toGlobPattern(inputPath: string): string {
    return normalizeFsPath(inputPath).split(path.sep).join("/");
}
