/**
 * Shared, bounded PostgREST pagination for assignment data access.
 *
 * Callers must provide a deterministic order in each page query. Keeping the
 * fetch callback typed at the boundary lets each selector retain its own
 * business filters while sharing one completeness-safe paging implementation.
 */
export const DEFAULT_POSTGREST_PAGE_SIZE = 1000;

export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => Promise<{
    data: T[] | null;
    error: unknown | null;
  }>,
  pageSize = DEFAULT_POSTGREST_PAGE_SIZE,
): Promise<T[]> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error("Page size must be a positive safe integer.");
  }

  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw error;

    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}
