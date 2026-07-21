// Avvisi di sistema SOLO admin — registra quando una funzione AI non risponde (down)
// e quando torna disponibile (recovered). Non deve MAI far fallire la funzione chiamante.
export async function reportAiStatus(
  SUPABASE_URL: string,
  SERVICE_KEY: string,
  key: string,
  ok: boolean,
  label: string,
  meta: { source?: string; engine?: string; model?: string } = {},
): Promise<void> {
  const H = { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' }
  const now = new Date().toISOString()
  try {
    if (!ok) {
      await fetch(`${SUPABASE_URL}/rest/v1/isi_admin_alerts?on_conflict=key`, {
        method: 'POST',
        headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          key, type: 'ai_down', status: 'down',
          source: meta.source ?? null, engine: meta.engine ?? null, model: meta.model ?? null,
          message: `${label} non risponde (possibile limite di quota o servizio AI momentaneamente non disponibile)`,
          last_seen: now, recovered_at: null, resolved: false,
        }),
      })
    } else {
      // Ripristino: aggiorna a "tornato disponibile" solo se c'era un guasto aperto
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/isi_admin_alerts?key=eq.${encodeURIComponent(key)}&status=eq.down&resolved=eq.false&select=id`,
        { headers: H },
      )
      const rows = await r.json().catch(() => [])
      if (Array.isArray(rows) && rows.length) {
        await fetch(`${SUPABASE_URL}/rest/v1/isi_admin_alerts?key=eq.${encodeURIComponent(key)}`, {
          method: 'PATCH',
          headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'recovered', message: `${label} è tornato disponibile`, recovered_at: now, last_seen: now }),
        })
      }
    }
  } catch (_) { /* silenzioso: gli avvisi non devono mai rompere la funzione */ }
}
