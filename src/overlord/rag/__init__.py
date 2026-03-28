"""
This module allows to index the content of a folder in the workspace.
When file changes are detected, the index is update automatically.
We can then generate a markdown summary on demand, which can be used in the system prompt of the agent to give it an up-to-date overview of the workspace content.

This module uses Qdrant as vector database, and there is no plan to make it configurable

"""

import re
from pathlib import Path
from typing import cast

from langchain_core.embeddings import Embeddings
from langchain_qdrant import QdrantVectorStore
from langchain_text_splitters import (CharacterTextSplitter,
                                      ExperimentalMarkdownSyntaxTextSplitter,
                                      LatexTextSplitter,
                                      RecursiveCharacterTextSplitter,
                                      RecursiveJsonSplitter)
from langchain_text_splitters.base import Language, TextSplitter
from loguru import logger
from markdown_strings import (  # type: ignore[import-untyped] # FIX ME
    esc_format, table_delimiter_row, table_row)
from qdrant_client import QdrantClient
from qdrant_client.http.models import (Distance, FieldCondition, Filter,
                                       FilterSelector, MatchValue,
                                       VectorParams)
from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from ..utils.extract import extract_text_from_file

# mapping of programming languages to file extensions, used to determine which splitter to use for each file
LANGUAGE_TO_EXTENSIONS = {
    Language.CPP: (".cpp", ".cxx", ".h", ".hpp"),
    Language.GO: (".go",),
    Language.JAVA: (".java",),
    Language.KOTLIN: (".kt", ".kts"),
    Language.JS: (".js", ".jsx"),
    Language.TS: (".ts", ".tsx"),
    Language.PHP: (".php",),
    Language.PYTHON: (".py",),
    Language.R: (".r",),
    Language.RST: (".rst",),
    Language.RUBY: (".rb",),
    Language.RUST: (".rs",),
    Language.SCALA: (".scala",),
    Language.SWIFT: (".swift",),
    Language.SOL: (".sol",),
    Language.CSHARP: (".cs",),
    Language.COBOL: (".cobol",),
    Language.C: (".c",),
    Language.LUA: (".lua",),
    Language.PERL: (".pl",),
    Language.HASKELL: (".hs",),
    Language.ELIXIR: (".ex", ".exs"),
    Language.POWERSHELL: (".ps1",),
    Language.VISUALBASIC6: (".vb", ".vba"),
    Language.HTML: (".html", ".htm"),
}


SPLITTERS = {
    ".md": lambda: ExperimentalMarkdownSyntaxTextSplitter(),
    ".json": lambda: RecursiveJsonSplitter(),
    ".tex": lambda: LatexTextSplitter(),
}

for language, extensions in LANGUAGE_TO_EXTENSIONS.items():
    for ext in extensions:
        SPLITTERS[ext] = lambda lang=language: (  # type: ignore[misc] # FIX ME
            RecursiveCharacterTextSplitter.from_language(language=lang)
        )


class RagIndex(FileSystemEventHandler):
    def __init__(
        self,
        workspace_path: Path,
        embedding_model: Embeddings,
        documents_path: Path | None = None,
        ndim: int | None = None,
        watch: bool = True,
    ):
        self.workspace_path = workspace_path.absolute().resolve()
        self.embedding_model = embedding_model
        self.ndim = ndim

        # if ndim is None, run the model once on a dummy input to get the dimensions, to avoid having to specify it in the configuration
        if self.ndim is None:
            self.ndim = len(self.embedding_model.embed_query("test"))
            logger.info(f"Detected dimensions of the embedding model: {self.ndim}")
        self.documents_folder = documents_path or workspace_path
        self.documents_folder = self.documents_folder.absolute().resolve()
        self.documents_folder.mkdir(parents=True, exist_ok=True)

        if self.workspace_path != self.documents_folder:
            assert self.documents_folder.is_relative_to(self.workspace_path), (
                "documents_path must be a subfolder of workspace_path"
            )

        index_path = self.documents_folder / ".qdrant_data"
        self.qdrant_client = QdrantClient(path=index_path.as_posix())
        collection_names = [
            collection.name
            for collection in self.qdrant_client.get_collections().collections
        ]
        if "docs" not in collection_names:
            self.qdrant_client.create_collection(
                collection_name="docs",
                vectors_config=VectorParams(size=self.ndim, distance=Distance.COSINE),
            )
        self.vector_store = QdrantVectorStore(
            client=self.qdrant_client,
            collection_name="docs",
            embedding=self.embedding_model,
        )

        self.observer = Observer()
        self.observer.schedule(self, str(self.documents_folder), recursive=True)
        if watch:
            self.observer.start()

    def on_created(self, event: FileSystemEvent):  # type: ignore[no-untyped-def] # FIX ME
        if not event.is_directory:
            self._embed_file(event.src_path)  # type: ignore[arg-type] # FIX ME

    def on_deleted(self, event: FileSystemEvent):  # type: ignore[no-untyped-def] # FIX ME
        if not event.is_directory:
            self._remove_file(event.src_path)  # type: ignore[arg-type] # FIX ME

    def on_moved(self, event: FileSystemEvent):  # type: ignore[no-untyped-def] # FIX ME
        if not event.is_directory:
            self._remove_file(event.src_path)  # type: ignore[arg-type] # FIX ME
            self._embed_file(event.dest_path)  # type: ignore[arg-type] # FIX ME

    def _embed_file(self, file: str):  # type: ignore[no-untyped-def] # FIX ME
        file_path = Path(file).resolve()
        if not file_path.is_file() or file_path.name.startswith("."):
            return

        ext, content = extract_text_from_file(file_path)

        splitter_builder = SPLITTERS.get(ext, lambda: CharacterTextSplitter())
        splitter = cast(TextSplitter, splitter_builder())  # type: ignore[no-untyped-call] # FIX ME
        key = file_path.relative_to(self.documents_folder).as_posix()
        logger.info(f"Indexing {key}")
        texts = splitter.split_text(content)
        metadatas = [
            {
                "src": key,
                "chunk_index": i,
                "ext": file_path.suffix,
                "mtime": file_path.stat().st_mtime,
            }
            for i in range(len(texts))
        ]
        self.vector_store.add_texts(
            texts=texts,
            metadatas=metadatas,
        )

    def _remove_file(self, file: str):  # type: ignore[no-untyped-def] # FIX ME
        file_path = Path(file).resolve()
        if file_path.name.startswith("."):
            return
        key = file_path.relative_to(self.documents_folder.resolve()).as_posix()
        logger.info(f"Removing {key} from index")
        # count_before = self.qdrant_client.count(collection_name="docs")
        self.qdrant_client.delete(
            collection_name="docs",
            points_selector=FilterSelector(
                filter=Filter(
                    must=[
                        FieldCondition(
                            key="metadata.src",  # langchain stores metadata in a "metadata" field, and the source file path in a "src" field inside the metadata
                            match=MatchValue(value=key),
                        )
                    ]
                )
            ),
            wait=True,  # wait for the deletion to be applied before returning, to avoid having stale results in subsequent searches
        )
        # logger.debug(update_result.model_dump_json(indent=2))
        # count_after = self.qdrant_client.count(collection_name="docs")
        # logger.info(
        #    f"Count before deletion: {count_before}, count after deletion: {count_after}"
        # )

    def generate_summary(
        self,
        text: str,
        max_items: int = 5,
        filename_column: str = "Source file",
        excerpt_column: str = "Why it may be relevant",
    ) -> str:
        """Generate a markdown summary of indexed documents, sorted by relevance."""
        vector = self.embedding_model.embed_query(text)

        # Fetch more chunks than needed so we can deduplicate by file
        results = self.vector_store.similarity_search_by_vector(vector, k=max_items * 4)

        if len(results) == 0:
            return "(No relevant documents found.)"

        md = "Potentially relevant workspace files for the current task. If needed, inspect the source files below for full context.\n\n"
        md += table_row([filename_column, excerpt_column]) + "\n"
        md += table_delimiter_row(2) + "\n"

        seen = set()
        count = 0

        for result in results:
            doc_path = result.metadata.get("src")
            if not doc_path or doc_path in seen:
                continue

            seen.add(doc_path)

            cleaned_content = re.sub(r"\s+", " ", result.page_content.strip())
            excerpt = f"… {esc_format(cleaned_content, esc=True)} …"

            md += table_row([doc_path, excerpt]) + "\n"

            count += 1
            if count >= max_items:
                break

        if count == 0:
            return "(No relevant documents found.)"

        return md  # type: ignore[no-any-return] # FIX ME