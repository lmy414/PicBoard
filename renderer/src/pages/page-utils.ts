/** Turn a host rejection into a concise, Chinese-first message. */
export function hostErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return `${fallback}：${error.message}`;
  if (typeof error === "string" && error) return `${fallback}：${error}`;
  return fallback;
}
