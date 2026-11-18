// Vercel Cron target (see vercel.json). The backend runs on Render's free tier
// and sleeps when idle; any request wakes it, and on boot it runs every daily
// job (news pipeline, newsletter, cleanup) that was due but hasn't run yet.
// This route only wakes it, so it needs no backend secret.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  // A cold start takes ~30-60 s, so retry until the backend answers.
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < 55_000) {
    try {
      const res = await fetch(`${API_URL}/health`, { cache: 'no-store', signal: AbortSignal.timeout(20_000) })
      if (res.ok) {
        return Response.json({ awake: true, ms: Date.now() - started })
      }
      lastError = `HTTP ${res.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((r) => setTimeout(r, 5_000))
  }
  return Response.json({ awake: false, error: lastError }, { status: 502 })
}
