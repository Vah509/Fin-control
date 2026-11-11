import { useApp, useAsync, type Async } from './app'
import { errorText } from './format'

/** useAsync с текстами ошибок по умолчанию; перечитывает данные после записи (version). */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []): Async<T> {
  const { version } = useApp()
  return useAsync(fn, [version, ...deps], errorText)
}
