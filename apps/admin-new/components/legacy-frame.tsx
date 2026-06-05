'use client'

const LEGACY_URL = process.env.NEXT_PUBLIC_LEGACY_URL ?? 'https://admin.ottaly.co.uk'

export function LegacyFrame({ path }: { path: string }) {
  return (
    <div className="flex flex-col h-screen">
      <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-center justify-between">
        <span className="text-sm text-amber-700">This page is running on the legacy dashboard. It will be migrated soon.</span>
        <a href={`${LEGACY_URL}${path}`} target="_blank" rel="noopener noreferrer" className="text-xs text-amber-600 hover:underline">Open in legacy →</a>
      </div>
      <iframe
        src={`${LEGACY_URL}${path}`}
        className="flex-1 w-full border-0"
        title="Legacy page"
      />
    </div>
  )
}
