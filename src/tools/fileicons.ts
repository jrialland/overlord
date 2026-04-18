import path from "path";

const defaultFileIcon = "📄";

const iconsByFileName: Record<string, string> = {
    ".dockerignore": "🐳",
    ".env": "🔐",
    ".env.example": "🔐",
    ".gitattributes": "🌿",
    ".gitignore": "🙈",
    "bun.lock": "🔒",
    "bunfig.toml": "🥟",
    "dockerfile": "🐳",
    "containerfile": "🐳",
    "editorconfig": "🎨",
    "eslintignore": "🧹",
    "eslintrc": "🧹",
    "eslint.json": "🧹",
    "eslint.yaml": "🧹",
    "eslint.yml": "🧹",
    "license": "⚖️",
    "makefile": "🏗️",
    "pyproject.toml": "🐍",
    "package-lock.json": "🔒",
    "package.json": "📦",
    "pnpm-lock.yaml": "🔒",
    "readme": "📘",
    "readme.md": "📘",
    "tsconfig.json": "⚙️",
    "yarn.lock": "🔒",
};

const iconsByExtension: Record<string, string> = {
    // Documents and data
    ".csv": "📊",
    ".doc": "📄",
    ".docx": "📄",
    ".epub": "📚",
    ".json": "🧾",
    ".json5": "🧾",
    ".md": "📘",
    ".pdf": "📕",
    ".ppt": "📽️",
    ".pptx": "📽️",
    ".toml": "⚙️",
    ".txt": "📄",
    ".xls": "📊",
    ".xlsx": "📊",
    ".yaml": "⚙️",
    ".yml": "⚙️",

    // Images and design assets
    ".ai": "🎨",
    ".bmp": "🖼️",
    ".gif": "🖼️",
    ".ico": "🖼️",
    ".jpeg": "🖼️",
    ".jpg": "🖼️",
    ".png": "🖼️",
    ".psd": "🎨",
    ".svg": "🖼️",
    ".webp": "🖼️",

    // Archives
    ".7z": "📦",
    ".gz": "📦",
    ".rar": "📦",
    ".tar": "📦",
    ".tgz": "📦",
    ".zip": "📦",
    ".xz": "📦",
    ".zst": "📦",
    ".zstd": "📦",
    ".z": "📦",
    ".cpio": "📦",

    // Web and markup
    ".css": "🎨",
    ".html": "🌐",
    ".scss": "🎨",
    ".xml": "📃",

    // Code and configuration
    ".c": "📜",
    ".cpp": "📜",
    ".cs": "🔷",
    ".go": "🐹",
    ".h": "📜",
    ".java": "☕",
    ".js": "📜",
    ".jsx": "⚛️",
    ".kt": "🅺",
    ".mjs": "📜",
    ".php": "🐘",
    ".py": "🐍",
    ".rb": "💎",
    ".rs": "🦀",
    ".sh": "🐚",
    ".sql": "🗄️",
    ".swift": "🦅",
    ".ts": "🆃",
    ".tsx": "⚛️",
    ".vue": "💚",
    ".gradle": "🔧",

    // Executables and scripts
    ".app": "📱",
    ".bat": "⚙️",
    ".bin": "⚙️",
    ".cmd": "⚙️",
    ".cpl": "⚙️",
    ".exe": "⚙️",
    ".ps1": "⚙️",
    ".run": "⚙️",

    // Audio and video
    ".avi": "🎬",
    ".mkv": "🎬",
    ".mov": "🎬",
    ".mp3": "🎵",
    ".mp4": "🎬",
    ".ogg": "🎵",
    ".wav": "🎵",
    ".webm": "🎬",
    ".wmv": "🎬",
    ".flac": "🎵",
    ".aac": "🎵",
    ".flv": "🎬",
    ".m4a": "🎵",
    ".mpeg": "🎬",
    ".mpg": "🎬",
    ".mid": "🎵",
    ".xvid": "🎬",
    ".opus": "🎵",
    ".3gp": "🎬",
    ".divx": "🎬",
    ".vob": "🎬",
};

export function getFileIcon(fileName: string): string {
    const normalizedFileName = path.basename(fileName).toLowerCase();
    const iconByName = iconsByFileName[normalizedFileName];
    if (iconByName) {
        return iconByName;
    }

    const ext = path.extname(fileName).toLowerCase();
    return iconsByExtension[ext] || defaultFileIcon;
}