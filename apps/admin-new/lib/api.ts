const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

export async function legacyFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${LEGACY_API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`Legacy API error: ${res.status} ${path}`)
  return res.json()
}
