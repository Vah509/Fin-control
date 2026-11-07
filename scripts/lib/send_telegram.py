# scripts/lib/send_telegram.py
# Отправка сообщений в Telegram через Bot API (только стандартная библиотека).
# Секреты: TELEGRAM_TOKEN, TELEGRAM_TO. Функция никогда не бросает исключение:
# сбой Telegram не должен прервать обработку архива.

import json
import os
import urllib.error
import urllib.request

TELEGRAM_API = "https://api.telegram.org"
MAX_LIST_CHARS = 2500  # запас до лимита Telegram (4096)


def send_telegram_message(text: str) -> None:
    token = os.environ.get("TELEGRAM_TOKEN")
    chat_id = os.environ.get("TELEGRAM_TO")
    if not token or not chat_id:
        print("⚠️  TELEGRAM_TOKEN / TELEGRAM_TO не заданы, сообщение не отправлено:\n" + text)
        return

    payload = json.dumps({"chat_id": chat_id, "text": text[:4000], "parse_mode": "Markdown"}).encode("utf-8")
    req = urllib.request.Request(
        f"{TELEGRAM_API}/bot{token}/sendMessage",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status >= 300:
                print(f"⚠️  Telegram вернул {resp.status}")
    except urllib.error.HTTPError as err:
        # Чаще всего 400 из-за разметки. Повторяем простым текстом.
        print(f"⚠️  Telegram HTTP {err.code}, повтор без разметки")
        try:
            plain = json.dumps({"chat_id": chat_id, "text": text[:4000]}).encode("utf-8")
            req2 = urllib.request.Request(req.full_url, data=plain,
                                          headers={"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req2, timeout=10).close()
        except Exception as err2:  # noqa: BLE001
            print(f"⚠️  Повтор тоже не удался: {err2}")
    except Exception as err:  # noqa: BLE001
        print(f"⚠️  Не удалось обратиться к Telegram: {err}")


def _file_lines(files: list[str]) -> list[str]:
    lines, used = [], 0
    for i, f in enumerate(files):
        line = f"`{f}`"
        if used + len(line) > MAX_LIST_CHARS:
            lines.append(f"… и ещё {len(files) - i}")
            break
        lines.append(line)
        used += len(line) + 1
    return lines or ["----"]


def build_info_message(repo: str, time_str: str, zip_name: str, files: list[str],
                       rejected: list[str], warnings: list[str]) -> str:
    lines = [
        f"📦 **Репозиторий:** `{repo}`",
        f"⏱️ **Время:** *{time_str}*",
        f"📄 **Архив:** `{zip_name}`",
        "",
        "⚡ **Обновление: тестовая сборка запущена**",
        "",
        f"🔄 **Файлы ({len(files)}):**",
        *_file_lines(files),
    ]
    if rejected:
        lines += ["", "🚫 **Пропущены (не применяются автоматикой):**", *[f"`{r}`" for r in rejected[:15]]]
    if warnings:
        lines += ["", "⚠️ **Предупреждения:**", *[f"• {w}" for w in warnings[:15]]]
    return "\n".join(lines)


def build_result_message(success: bool, repo: str, time_str: str, summary: str | None) -> str:
    head = "🟢 **Обновление принято, сборка прошла**" if success else "🔴 **Сборка не прошла, репозиторий не изменён**"
    lines = [head, f"📦 **Репозиторий:** `{repo}`", f"⏱️ **Время:** *{time_str}*"]
    if summary:
        lines += ["", "```", summary.replace("`", "'")[:2000], "```"]
    return "\n".join(lines)
