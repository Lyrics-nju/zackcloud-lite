import { buildSnapshot, parseSnapshot, SNAPSHOT_KEY } from "./snapshot";
import type { BuiltSnapshot, SubscriptionSnapshot } from "./snapshot";
import { fetchUpstream } from "./upstream";
import type { Fetcher } from "./types";

export interface SnapshotWriter {
  put(key: string, value: string): Promise<void>;
}

export async function buildFromUpstream(url: string, fetcher: Fetcher = fetch): Promise<BuiltSnapshot> {
  const upstream = await fetchUpstream(url, fetcher);
  return buildSnapshot(upstream.body, upstream.response.headers);
}

export async function publishSnapshot(writer: SnapshotWriter, snapshot: SubscriptionSnapshot): Promise<void> {
  const serialized = JSON.stringify(snapshot);
  if (await parseSnapshot(serialized) === null) throw new Error("refusing to publish invalid snapshot");
  await writer.put(SNAPSHOT_KEY, serialized);
}
