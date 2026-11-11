import { useState, type FormEvent } from 'react'
import { errorText } from '../format'

export function Login({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try { await onLogin(email, password) } catch (err) { setError(errorText(err)); setBusy(false) }
  }

  return (
    <main className="login">
      <h1>Fin-control</h1>
      <p className="muted">Вход владельца</p>
      <form onSubmit={submit}>
        <label>Почта
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>Пароль
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="box error" role="alert">{error}</div>}
        <button className="btn primary" disabled={busy}>{busy ? 'Входим…' : 'Войти'}</button>
      </form>
    </main>
  )
}
