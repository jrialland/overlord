
from pathlib import Path

from langchain_ollama.embeddings import OllamaEmbeddings

from overlord.rag import RagIndex


def test_rag(workspace_path: Path):
    embedding_model = OllamaEmbeddings(model="nomic-embed-text-v2-moe:latest")
    rag_index = RagIndex(workspace_path=workspace_path, embedding_model=embedding_model, watch=False)

    # index a file:
    test_file = workspace_path / "documentation" / "test.txt"
    test_file.parent.mkdir(parents=True, exist_ok=True)
    test_file.write_text("This is a test file for the RAG index.")
    rag_index._embed_file(test_file.as_posix())
    
    # check that the file is indexed
    result = rag_index.generate_summary("RAG")
    print(result)
    assert "test.txt" in result, f"Expected 'test.txt' to be in the summary, got: {result}"

    # remove the file
    test_file.unlink()
    rag_index._remove_file(test_file.as_posix())
    # check that the file name does not appear in search results anymore
    result = rag_index.generate_summary("RAG")
    assert "test.txt" not in result, f"Expected 'test.txt' to be removed from the summary, got: {result}"