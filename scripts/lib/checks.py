# scripts/lib/checks.py
# Мягкие проверки архива. Не блокируют обновление, а попадают в Telegram.
# Сами SQL-миграции автоматика НЕ применяет к Supabase: они проверяются
# заранее (в песочнице Claude) и просто копируются в supabase/migrations/.

import os
import posixpath
import re

MIGRATION_RE = re.compile(r"^\d{14}_[a-z0-9_]+\.sql$")


def migration_warnings(accepted: list[str], repo_root: str, staging_dir: str) -> list[str]:
    out = []
    for name in accepted:
        if not name.startswith("supabase/migrations/") or not name.endswith(".sql"):
            continue
        base = posixpath.basename(name)
        new_path = os.path.join(staging_dir, name)
        if os.path.getsize(new_path) == 0:
            out.append(f"пустая миграция `{base}`")
        if not MIGRATION_RE.match(base):
            out.append(f"имя миграции `{base}` не по шаблону ГГГГММДДччммсс_название.sql")
        old_path = os.path.join(repo_root, name)
        if os.path.exists(old_path):
            with open(old_path, "rb") as a, open(new_path, "rb") as b:
                if a.read() != b.read():
                    out.append(f"изменена уже существующая миграция `{base}` (если она применена, нужна новая)")
    return out
