/** Request parameters only: no provider configuration, network or image dependencies. */
export function openAiTokenOptions(model: string, budget: number, legacyTemperature?: number) {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('Invalid token budget');
  if (legacyTemperature !== undefined && (!Number.isFinite(legacyTemperature) || legacyTemperature < 0 || legacyTemperature > 2)) throw new Error('Invalid temperature');
  const name = model.trim().split('/').at(-1)?.toLowerCase() || '';
  return /^(?:gpt-5(?:[.-]|$)|o[134](?:-|$))/.test(name)
    ? { max_completion_tokens: budget, reasoning_effort: 'low' as const }
    : { max_tokens: budget, ...(legacyTemperature === undefined ? {} : { temperature: legacyTemperature }) };
}
