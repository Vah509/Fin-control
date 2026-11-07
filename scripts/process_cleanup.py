#!/usr/bin/env python3
# scripts/process_cleanup.py
# Ручное удаление файлов/папок по списку из cleanup-requests/*.txt.
# Запускается ТОЛЬКО вручную (Actions → Repo Cleanup → Run workflow).
#
# Формат списка: один путь на строку, относительно корня репозитория;
# пустые строки и строки с # игнорируются. Только явно перечисленное,
# без масок. Пути вне репозитория и защищённые папки пропускаются.
# Отсутствующий путь не ошибка, а пометка в отчёте.

import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(__file__))
from lib.send_telegram import send_telegram_message

REPO_ROOT = os.path.realpath(os.getcwd())
REQUESTS_DIR = os.path.join(REPO_ROOT, "cleanup-requests")
PROTECTED = {".git", ".github", "scripts", "ai-updates", "cleanup-requests"}


def find_list() -> str | None:
    if not os.path.isdir(REQUESTS_DIR):
        return None
    files = sorted(f for f in os.listdir(REQUESTS_DIR) if f.endswith(".txt"))
    return os.path.join(REQUESTS_DIR, files[0]) if files else None


def read_paths(path: str) -> list[str]:
    with open(path, encoding="utf-8") as f:
        return [l.strip() for l in f if l.strip() and not l.strip().startswith("#")]


def delete_path(rel: str) -> str:
    full = os.path.realpath(os.path.join(REPO_ROOT, rel))
    if full == REPO_ROOT or not full.startswith(REPO_ROOT + os.sep):
        return f"⚠️ ПРОПУЩЕНО (вне репозитория): `{rel}`"
    top = os.path.relpath(full, REPO_ROOT).split(os.sep)[0]
    if top in PROTECTED:
        return f"⚠️ ПРОПУЩЕНО (защищённый путь): `{rel}`"
    if not os.path.lexists(full):
        return f"⏭️ Уже отсутствует: `{rel}`"
    try:
        if os.path.isdir(full) and not os.path.islink(full):
            shutil.rmtree(full)
            return f"🗑️ Удалена папка: `{rel}`"
        os.remove(full)
        return f"🗑️ Удалён файл: `{rel}`"
    except OSError as err:
        return f"❌ Ошибка удаления `{rel}`: {err}"


def main() -> None:
    repo = os.path.basename(REPO_ROOT)
    list_file = find_list()
    if not list_file:
        send_telegram_message(f"📦 **Репозиторий:** `{repo}`\nℹ️ В `cleanup-requests/` нет `.txt` со списком.")
        return
    name = os.path.basename(list_file)
    paths = read_paths(list_file)
    if not paths:
        send_telegram_message(f"📦 **Репозиторий:** `{repo}`\nℹ️ Список `{name}` пуст, ничего не удалено.")
        return

    results = [delete_path(p) for p in paths]
    for r in results:
        print(r)
    os.remove(list_file)

    send_telegram_message("\n".join(
        ["🧹 **Ручная очистка репозитория**", f"📦 **Репозиторий:** `{repo}`", f"📄 **Список:** `{name}`", "", *results]))


if __name__ == "__main__":
    main()
