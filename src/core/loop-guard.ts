// A no-progress guard for Bee's tool loops (direct requests in luna.ts, computer use in computer-use.ts). Those loops have no step
// cap: they run until the AI stops, the user stops them, or this guard sees the same tool call give the same result again and
// again. Pure: no Electron, no timers.

/** The same call with the same result this many times in a row: the loop is going nowhere. */
export const LOOP_REPEATS = 3;

type StepLike = {
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input?: unknown }>;
  toolResults: ReadonlyArray<{ toolCallId: string; output?: unknown }>;
};

const json = (value: unknown) => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
};

/** True once the newest LOOP_REPEATS tool calls, in order, are one call (name and input) with one result. */
export function noProgress(steps: readonly StepLike[], repeats = LOOP_REPEATS): boolean {
  const seen: string[] = [];
  for (const step of steps) {
    const results = new Map(step.toolResults.map((result) => [result.toolCallId, result.output]));
    for (const call of step.toolCalls) seen.push(`${call.toolName}\u0000${json(call.input)}\u0000${json(results.get(call.toolCallId))}`);
  }
  if (seen.length < repeats) return false;
  const tail = seen.slice(-repeats);
  return tail.every((item) => item === tail[0]);
}

/** A stop condition for streamText / generateText: no-progress loops only. onLoop runs once, when it trips. */
export function stopOnNoProgress(onLoop?: () => void, repeats = LOOP_REPEATS) {
  let tripped = false;
  return ({ steps }: { steps: readonly StepLike[] }): boolean => {
    if (!noProgress(steps, repeats)) return false;
    if (!tripped) onLoop?.();
    tripped = true;
    return true;
  };
}
