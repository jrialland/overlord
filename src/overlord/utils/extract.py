"""
This module provides a unique utility function that extract text from a file.
"""

from pathlib import Path

from markitdown import MarkItDown

md = MarkItDown(enable_plugins=True)

USE_FOR_EXTENSIONS = (".pdf", ".docx", ".xlsx", ".pptx")


def extract_text_from_file(file_path: Path) -> tuple[str, str]:
    """
    Use various methods to extract plain text from a file depending on its type.
        For supported document formats (pdf, docx, xlsx, pptx), it uses markitdown to extract text while preserving some structure.
        For other file types,  it just reads it...

    New extraction methods can be added here in the future if needed

    Args:
        file_path: Path to the file to extract text from

    Returns:
        A tuple with the extension to use for the splitter, and the extracted text content

    """
    # check if extension is supported by markitdown
    if file_path.suffix in USE_FOR_EXTENSIONS:
        result = md.convert(file_path.as_posix())
        return '.md', result.text_content
    else:
        return file_path.suffix, file_path.read_text(encoding="utf-8", errors="replace")
