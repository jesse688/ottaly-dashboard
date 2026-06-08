// DataForSEO requires "and" between each filter condition:
// [["field", "op", val], "and", ["field", "op", val]]
export function buildFilters(filters: Record<string, unknown>): unknown[] | undefined {
  const conditions: [string, string, unknown][] = []

  if (filters?.requireDomain)  conditions.push(['domain', '<>', null])
  if (filters?.claimedOnly)    conditions.push(['is_claimed', '=', true])
  if (filters?.requirePhone)   conditions.push(['phone', '<>', null])
  if (typeof filters?.minRating === 'number' && (filters.minRating as number) > 0)
    conditions.push(['rating.value', '>=', filters.minRating])
  if (typeof filters?.minReviews === 'number' && (filters.minReviews as number) > 0)
    conditions.push(['rating.votes_count', '>=', filters.minReviews])

  if (!conditions.length) return undefined

  // Interleave with "and"
  const result: unknown[] = []
  conditions.forEach((c, i) => {
    result.push(c)
    if (i < conditions.length - 1) result.push('and')
  })
  return result
}
