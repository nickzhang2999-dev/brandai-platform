function branchQueuePrefix(branch: string | undefined): string | null {
  if (!branch) return null;
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug ? `brandai-${slug}` : null;
}

export const queuePrefix =
  process.env.BRANDAI_QUEUE_PREFIX ||
  branchQueuePrefix(process.env.VITE_GIT_BRANCH) ||
  process.env.BULLMQ_PREFIX ||
  "bull";
