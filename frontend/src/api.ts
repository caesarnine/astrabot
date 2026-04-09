export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
    ...options,
  })

  if (!response.ok) {
    let detail = 'Request failed.'
    try {
      const data = (await response.json()) as { detail?: string }
      if (data.detail) {
        detail = data.detail
      }
    } catch {
      // Ignore malformed error payloads and use the generic message.
    }
    throw new Error(detail)
  }

  return (await response.json()) as T
}
