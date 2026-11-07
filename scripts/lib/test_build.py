# scripts/lib/test_build.py
# Тестовая сборка клиента (Vite + React + TypeScript) в staging.
# Успех = npm ci / npm install проходит и `npm run build` завершается с кодом 0.
# В шаблонах Vite скрипт build включает `tsc -b`, так что типы проверяются.
# Если package.json ещё нет (этап инфраструктуры), собирать нечего: успех.
# Тесты не гоняем (проверяются заранее в песочнице Claude).

import json
import os
import subprocess

INSTALL_TIMEOUT = 900
BUILD_TIMEOUT = 600

# Заглушки, чтобы код, читающий import.meta.env, не падал на сборке.
DUMMY_ENV = {"VITE_SUPABASE_URL": "http://localhost:54321", "VITE_SUPABASE_ANON_KEY": "test-anon-key"}


def _tail(text: str, lines: int = 12) -> str:
    parts = [l for l in text.split("\n") if l.strip()]
    return "\n".join(parts[-lines:]) or "Пустой вывод"


def _run(cmd: list[str], cwd: str, timeout: int, env: dict) -> tuple[bool, str]:
    try:
        r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, f"таймаут {timeout}с: {' '.join(cmd)}"
    if r.returncode != 0:
        return False, _tail(f"{r.stdout}\n{r.stderr}")
    return True, ""


def test_build(staging_dir: str) -> dict:
    pkg = os.path.join(staging_dir, "package.json")
    if not os.path.exists(pkg):
        return {"success": True, "summary": "package.json нет: собирать нечего, файлы приняты без сборки."}

    try:
        with open(pkg, encoding="utf-8") as f:
            scripts = json.load(f).get("scripts", {})
    except Exception as err:  # noqa: BLE001
        return {"success": False, "summary": f"package.json повреждён: {err}"}
    if "build" not in scripts:
        return {"success": False, "summary": "в package.json нет скрипта build"}

    env = {**os.environ, **DUMMY_ENV, "CI": "true"}
    has_lock = os.path.exists(os.path.join(staging_dir, "package-lock.json"))
    install = ["npm", "ci"] if has_lock else ["npm", "install"]

    ok, err = _run(install + ["--no-audit", "--no-fund"], staging_dir, INSTALL_TIMEOUT, env)
    if not ok:
        return {"success": False, "summary": f"{' '.join(install)} провалился:\n{err}"}

    ok, err = _run(["npm", "run", "build"], staging_dir, BUILD_TIMEOUT, env)
    if not ok:
        return {"success": False, "summary": f"npm run build провалился:\n{err}"}

    note = None if has_lock else "Нет package-lock.json: зависимости поставлены через npm install."
    return {"success": True, "summary": note}
