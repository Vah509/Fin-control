// Читаемые ключи для разделов и счетов: из названия, латиницей, уникальные.
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', є: 'ye', ё: 'e', ж: 'zh', з: 'z', и: 'i', і: 'i', ї: 'yi',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

/** «Приват Скарбничка» -> «privat-skarbnichka». Если ключ занят, добавляется -2, -3 и так далее. */
export function makeKey(name: string, taken: Iterable<string>, fallback = 'item'): string {
  const used = new Set(taken)
  // Сначала кириллица (иначе «й» и «ї» потеряют знаки при разборе), потом латиница с диакритикой (словацкая š, č).
  const base = [...name.toLowerCase()]
    .map((c) => TRANSLIT[c] ?? c)
    .join('')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '') || fallback
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const k = `${base}-${n}`
    if (!used.has(k)) return k
  }
}
