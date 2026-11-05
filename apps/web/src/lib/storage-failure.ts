/** Only an explicit missing object may invalidate a derived cache reference.
 * Authentication, network and bucket failures must never delete that reference. */
export function isMissingStorageObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; Code?: string };
  return e.name === "NoSuchKey" || e.Code === "NoSuchKey";
}
