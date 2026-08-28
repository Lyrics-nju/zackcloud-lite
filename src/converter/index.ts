import { clashConverter } from "./clash";
import { UnsupportedSubscriptionError } from "./types";
import type { SubscriptionConverter } from "./types";

const converters: readonly SubscriptionConverter[] = [clashConverter];

export function convertSubscription(input: string, contentType: string | null): string {
  const converter = converters.find((candidate) => candidate.canConvert(input, contentType));
  if (!converter) throw new UnsupportedSubscriptionError();
  return converter.convert(input);
}

export { detectSubscriptionFormat } from "./detector";

export { UnsupportedSubscriptionError } from "./types";
