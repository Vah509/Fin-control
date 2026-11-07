# scripts/lib/staging.py
# Песочница: копия репозитория во временной папке, поверх неё применяется
# архив. В реальный репозиторий переносятся ТОЛЬКО файлы из архива (не
# node_modules и не dist), и только после успешной сборки.

import os
import shutil

from .safe_zip import extract_accepted

STAGING_DIR = "/tmp/money-staging"
SKIP_COPY = (".git", "node_modules", "dist", ".venv", "__pycache__")


def create_staging(repo_root: str) -> str:
    shutil.rmtree(STAGING_DIR, ignore_errors=True)
    shutil.copytree(repo_root, STAGING_DIR, ignore=shutil.ignore_patterns(*SKIP_COPY), symlinks=True)
    return STAGING_DIR


def apply_archive(staging_dir: str, zip_path: str, accepted: list[str]) -> None:
    extract_accepted(zip_path, staging_dir, accepted)


def promote(staging_dir: str, repo_root: str, accepted: list[str]) -> None:
    """Копирует из staging в репозиторий только файлы, пришедшие в архиве."""
    for name in accepted:
        src = os.path.join(staging_dir, name)
        dst = os.path.join(repo_root, name)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)


def cleanup_staging() -> None:
    shutil.rmtree(STAGING_DIR, ignore_errors=True)
