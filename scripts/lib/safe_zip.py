# scripts/lib/safe_zip.py
# Чтение и безопасная распаковка ZIP. Автоматика не применяет файлы, которые
# могут сломать сам конвейер или утечь секреты: .git/, .github/ (токен
# GITHUB_TOKEN не имеет права менять workflow), scripts/, служебные папки
# автоматики, файлы .env с секретами, пути с `..`.

import os
import posixpath
import shutil
import zipfile

BLOCKED_PREFIXES = (".git/", ".github/", "scripts/", "ai-updates/", "cleanup-requests/",
                    "node_modules/", "__MACOSX/")
ENV_ALLOWED = {".env.example", ".env.sample"}


def _reject_reason(name: str) -> str | None:
    if name.startswith("/") or (len(name) > 1 and name[1] == ":"):
        return "абсолютный путь"
    norm = posixpath.normpath(name)
    if norm == ".." or norm.startswith("../") or "/../" in f"/{norm}/":
        return "выход за пределы репозитория"
    for p in BLOCKED_PREFIXES:
        if norm.startswith(p):
            return f"защищённая папка {p}"
    base = posixpath.basename(norm)
    if base == ".DS_Store":
        return "мусор macOS"
    if (base == ".env" or base.startswith(".env.")) and base not in ENV_ALLOWED:
        return "файл с секретами (.env)"
    return None


def inspect_archive(zip_path: str) -> tuple[list[str], list[str]]:
    """(принятые пути, отклонённые строки «путь: причина»)."""
    try:
        with zipfile.ZipFile(zip_path) as zf:
            names = [n.replace("\\", "/") for n in zf.namelist() if not n.endswith("/")]
    except Exception as err:  # noqa: BLE001
        raise RuntimeError(f"Не удалось прочитать архив: {err}") from err

    accepted, rejected = [], []
    for n in names:
        reason = _reject_reason(n)
        if reason:
            rejected.append(f"{n}: {reason}")
        else:
            accepted.append(posixpath.normpath(n))
    return accepted, rejected


def extract_accepted(zip_path: str, dest: str, accepted: list[str]) -> None:
    ok = set(accepted)
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            name = info.filename.replace("\\", "/")
            if info.is_dir() or posixpath.normpath(name) not in ok:
                continue
            target = os.path.join(dest, posixpath.normpath(name))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
