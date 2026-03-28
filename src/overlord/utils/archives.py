import tarfile
import zipfile
from pathlib import Path
from typing import BinaryIO, Generator, cast

from loguru import logger


def extract_archive(archive_path: Path) -> Generator[tuple[str, BinaryIO]]:
    """
    Extracts files from a archive and yields their paths and file-like objects.
    Archives may be:
        - zip files (.zip)
        - tar files (.tar, .tar.gz, .tgz, .tar.bz2, .tbz2, .tar.xz, .txz)

    Args:
        archive_path (Path): The path to the archive.

    Yields:
        Generator[tuple[str, BinaryIO]]: A generator that yields tuples of file paths and file-like objects.
    """
    logger.info(f"Extracting archive: {archive_path}")
    if archive_path.suffix == ".zip":
        with zipfile.ZipFile(archive_path, "r") as zip_ref:
            for file_info in zip_ref.infolist():
                if not file_info.is_dir():
                    logger.debug(file_info.filename)
                    with zip_ref.open(file_info) as file:
                        yield file_info.filename, cast(BinaryIO, file)
    elif (suffix:=archive_path.suffix.lower()) in [".tar", ".gz", ".tgz", ".bz2", ".tbz2", ".xz", ".txz"]:
        mode: str = {
            ".tar": "r:",
            ".gz": "r:gz",
            ".tgz": "r:gz",
            ".bz2": "r:bz2",
            ".tbz2": "r:bz2",
            ".xz": "r:xz",
            ".txz": "r:xz",
        }[
            suffix
        ] or "r:*"  # auto-detect compression based on file signature

        with tarfile.open(archive_path, mode) as tar_ref:  # type: ignore[call-overload] # FIX ME
            for member in tar_ref.getmembers():
                if member.isfile():
                    file = tar_ref.extractfile(member)
                    if file is not None:
                        logger.debug(member.name)
                        yield member.name, cast(BinaryIO, file)
    else:
        raise ValueError(f"Unsupported archive format: {archive_path.suffix}")