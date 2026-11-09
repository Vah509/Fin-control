// Каркас. Экраны появятся в шаге 4б; они вызывают только ядро (src/core).
export function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <h1>Fin-control</h1>
      <p>Шаг 4а: ядро правил подключено, сборка работает.</p>
      <p>Экраны будут в шаге 4б.</p>
    </main>
  )
}
