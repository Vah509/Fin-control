// Вход владельца (email + пароль). Вне ядра и вне хранилища: ядру передаётся готовый Actor.
import type { SupabaseClient, Session } from '@supabase/supabase-js'
import type { Actor } from '../core/context'

export async function signIn(db: SupabaseClient, email: string, password: string): Promise<Session> {
  const { data, error } = await db.auth.signInWithPassword({ email: email.trim(), password })
  if (error || !data.session) throw new Error(`AUTH: ${error?.message ?? 'не удалось войти'}`)
  return data.session
}

export async function signOut(db: SupabaseClient): Promise<void> {
  const { error } = await db.auth.signOut()
  if (error) throw new Error(`AUTH: ${error.message}`)
}

export async function currentSession(db: SupabaseClient): Promise<Session | null> {
  const { data, error } = await db.auth.getSession()
  if (error) throw new Error(`AUTH: ${error.message}`)
  return data.session
}

/** Actor для ядра. userId должен совпадать с auth.uid(): иначе политика журнала отклонит запись.
 *  Владелец = есть хотя бы одна строка account_access с ролью owner. */
export async function loadActor(db: SupabaseClient, session: Session): Promise<Actor> {
  const userId = session.user.id
  const { data, error } = await db.from('account_access').select('role').eq('user_id', userId).eq('role', 'owner').limit(1)
  if (error) throw new Error(`AUTH: не удалось прочитать доступ: ${error.message}`)
  return { userId, isOwner: (data?.length ?? 0) > 0 }
}
