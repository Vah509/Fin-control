# Будильник для базы Supabase (Cloudflare Worker)

Зачем: бесплатный проект Supabase засыпает, если за неделю в базу пришло мало запросов.
Worker раз в сутки делает один простой запрос `select 1`, и база остаётся активной.
Когда данные переедут в SQLite на телефоне, Worker можно удалить.

Всё делается с телефона, ничего не нужно ставить на компьютер.

## Шаг 1. Функция в базе (один раз)

Supabase → проект → SQL Editor → вставьте одну строку и нажмите Run:

create or replace function public.keep_alive() returns integer language sql as 'select 1'; grant execute on function public.keep_alive() to anon;

Функция только возвращает число 1, к вашим данным доступа не даёт.

## Шаг 2. Создать Worker

Cloudflare → Workers & Pages → Create → Worker (шаблон Hello World).
Имя: `keep-alive`. Нажмите Deploy, затем Edit code, удалите всё и вставьте код ниже, снова Deploy.

```js
async function ping(env) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/keep_alive`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!r.ok) throw new Error(`ping ${r.status}: ${await r.text()}`)
  return r.status
}

export default {
  // Запуск по расписанию (Cron Trigger)
  async scheduled(event, env) {
    await ping(env)
  },
  // Ручная проверка: откройте адрес Worker в браузере
  async fetch(request, env) {
    try {
      return new Response(`OK, status ${await ping(env)}`)
    } catch (e) {
      return new Response(String(e), { status: 500 })
    }
  },
}
```

## Шаг 3. Переменные

Worker → Settings → Variables and secrets → Add:

- `SUPABASE_URL` = адрес проекта, вида `https://xxxx.supabase.co` (без слэша в конце)
- `SUPABASE_ANON_KEY` = публичный (anon / publishable) ключ

Это те же значения, что в настройках Pages (там они с приставкой `VITE_`). Ключ `service_role` сюда НЕ кладите.

## Шаг 4. Расписание

Worker → Settings → Triggers → Cron Triggers → Add:

`0 6 * * *` (каждый день в 06:00 UTC)

## Шаг 5. Проверка

Откройте адрес Worker (`keep-alive.<ваше-имя>.workers.dev`) в браузере.
Должно быть: `OK, status 200`.

Если ошибка:

- `404` или `PGRST202`: не выполнен шаг 1 или опечатка в имени функции.
- `401` или `403`: неверный ключ в `SUPABASE_ANON_KEY` или нет права `execute` (повторите шаг 1).
- `Invalid URL` или ошибка соединения: проверьте `SUPABASE_URL`.
- Пришлите текст ошибки в чат, разберём.

Названия пунктов в панели Cloudflare могут немного отличаться.
