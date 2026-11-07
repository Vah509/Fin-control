#!/usr/bin/env python3
# scripts/process_update.py
# Обработка обновления проекта. Вызывается из .github/workflows/unzip-and-update.yml.
#
# Шаги: найти ZIP в ai-updates/ → отфильтровать небезопасные пути →
# staging (копия репозитория) + распаковка → сообщение в Telegram №1 →
# тестовая сборка клиента → при успехе перенос файлов архива в репозиторий →
# сообщение №2 → УДАЛЕНИЕ ZIP И staging ВСЕГДА (try/finally).
# Код выхода: 0 успех, 1 провал (workflow всё равно коммитит удаление ZIP).

import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(__file__))

from lib.checks import migration_warnings
from lib.safe_zip import inspect_archive
from lib.send_telegram import build_info_message, build_result_message, send_telegram_message
from lib.staging import apply_archive, cleanup_staging, create_staging, promote
from lib.test_build import test_build

REPO_ROOT = os.getcwd()
AI_UPDATES_DIR = os.path.join(REPO_ROOT, "ai-updates")
TIMEZONE = "Europe/Bratislava"


def now() -> str:
    return datetime.now(ZoneInfo(TIMEZONE)).strftime("%H:%M:%S")


def find_zip() -> str | None:
    if not os.path.isdir(AI_UPDATES_DIR):
        return None
    zips = sorted(f for f in os.listdir(AI_UPDATES_DIR) if f.endswith(".zip"))
    return os.path.join(AI_UPDATES_DIR, zips[0]) if zips else None


def main() -> None:
    repo = os.path.basename(REPO_ROOT)
    zip_path = find_zip()
    if not zip_path:
        print("Архив не найден в ai-updates/: выход без действий.")
        return

    zip_name = os.path.basename(zip_path)
    started = now()
    ok = False

    try:
        accepted, rejected = inspect_archive(zip_path)
        if not accepted:
            send_telegram_message(build_result_message(
                False, repo, now(), "В архиве нет файлов, которые можно применить.\n" + "\n".join(rejected[:10])))
            return

        print("Создание staging...")
        staging = create_staging(REPO_ROOT)
        apply_archive(staging, zip_path, accepted)
        warnings = migration_warnings(accepted, REPO_ROOT, staging)

        send_telegram_message(build_info_message(repo, started, zip_name, accepted, rejected, warnings))

        print("Тестовая сборка...")
        result = test_build(staging)
        ok = result["success"]

        if ok:
            print("Сборка успешна: перенос файлов в репозиторий.")
            promote(staging, REPO_ROOT, accepted)
        else:
            print("Сборка провалилась: репозиторий не изменён.")

        send_telegram_message(build_result_message(ok, repo, now(), result["summary"]))

    except Exception as err:  # noqa: BLE001
        ok = False
        print(f"Неожиданная ошибка: {err}")
        send_telegram_message(build_result_message(False, repo, now(), f"Сбой автоматизации: {err}"))
    finally:
        try:
            if os.path.exists(zip_path):
                os.remove(zip_path)
        except OSError as err:
            print(f"Не удалось удалить ZIP: {err}")
        try:
            cleanup_staging()
        except OSError as err:
            print(f"Не удалось убрать staging: {err}")

    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
