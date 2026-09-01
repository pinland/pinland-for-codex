import { truncateUTF8 } from "./recent-history.mjs";

const DEFAULT_MAX_TITLE_BYTES = 4_096;
const DEFAULT_REFRESH_INTERVAL_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_INDEX_MAX_PAGES = 2;

function cleanTitle(value, maximumBytes = DEFAULT_MAX_TITLE_BYTES) {
  return truncateUTF8(typeof value === "string" ? value.trim() : "", maximumBytes);
}

function updateKey(session) {
  return Number.isFinite(session?.updated_at_ms)
    ? String(session.updated_at_ms)
    : "missing";
}

export class CurrentTitleIndex {
  constructor({
    refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    maxPages = DEFAULT_INDEX_MAX_PAGES,
    maxTitleBytes = DEFAULT_MAX_TITLE_BYTES
  } = {}) {
    this.refreshIntervalMs = Math.max(1, refreshIntervalMs);
    this.retryDelayMs = Math.max(1, retryDelayMs);
    this.maxPages = Math.max(1, maxPages);
    this.maxTitleBytes = Math.max(1, maxTitleBytes);
    this.names = new Map();
    this.checkedAtMs = undefined;
    this.retryAtMs = undefined;
  }

  async titlesFor(sessions, fetchPage, { now = Date.now() } = {}) {
    const targetIDs = new Set(sessions.map((session) => session.session_id));
    for (const sessionID of this.names.keys()) {
      if (!targetIDs.has(sessionID)) this.names.delete(sessionID);
    }
    if (!targetIDs.size) return this.names;

    const hasMissingTitle = [...targetIDs].some(
      (sessionID) => !this.names.has(sessionID)
    );
    const refreshIsDue = this.checkedAtMs === undefined
      || now - this.checkedAtMs >= this.refreshIntervalMs;
    if ((!hasMissingTitle && !refreshIsDue)
        || (this.retryAtMs !== undefined && this.retryAtMs > now)) {
      return this.names;
    }

    try {
      let cursor = null;
      const discovered = new Map();
      for (let page = 0; page < this.maxPages; page += 1) {
        const result = await fetchPage(cursor);
        if (!result || !Array.isArray(result.data)) {
          throw new Error("thread/list returned an invalid title page");
        }
        for (const thread of result.data) {
          if (!targetIDs.has(thread?.id)) continue;
          const title = cleanTitle(thread?.name, this.maxTitleBytes);
          if (title) discovered.set(thread.id, title);
        }
        if (discovered.size === targetIDs.size || !result.nextCursor) break;
        cursor = result.nextCursor;
      }
      for (const [sessionID, title] of discovered) {
        this.names.set(sessionID, title);
      }
      this.checkedAtMs = now;
      this.retryAtMs = undefined;
    } catch {
      this.retryAtMs = now + this.retryDelayMs;
    }
    return this.names;
  }
}

export function currentThreadTitle(result, options) {
  const thread = result?.thread && typeof result.thread === "object"
    ? result.thread
    : result;
  return cleanTitle(thread?.name, options?.maxTitleBytes);
}

function shouldRefresh(entry, key, now, refreshIntervalMs) {
  if (!entry) return true;
  if (entry.failedUpdateKey === key) return entry.retryAtMs <= now;
  if (entry.updateKey === key) return false;
  return now - entry.checkedAtMs >= refreshIntervalMs;
}

async function runWithConcurrency(values, concurrency, operation) {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        await operation(values[index]);
      }
    }
  );
  await Promise.all(workers);
}

// Section-filtered thread/list pages currently omit the user-assigned `name`
// even though thread/read and the ordinary task list return it. Resolve that
// field read-only, cache it, and only revisit a task after its update key has
// changed. The short throttle avoids hammering an actively updating task.
export async function attachCurrentTitles(sessions, cache, fetchThread, {
  now = Date.now(),
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  concurrency = DEFAULT_CONCURRENCY,
  maxTitleBytes = DEFAULT_MAX_TITLE_BYTES,
  currentNames = new Map()
} = {}) {
  const pinnedIDs = new Set(sessions.map((session) => session.session_id));
  for (const sessionID of cache.keys()) {
    if (!pinnedIDs.has(sessionID)) cache.delete(sessionID);
  }

  // An ordinary state-database thread/list page carries the current user
  // assigned name, while a section-filtered page can temporarily expose only
  // the immutable preview or cwd. Seed the per-task cache from that bounded
  // index before falling back to thread/read.
  for (const session of sessions) {
    const indexedTitle = cleanTitle(
      currentNames.get(session.session_id),
      maxTitleBytes
    );
    if (!indexedTitle) continue;
    cache.set(session.session_id, {
      updateKey: updateKey(session),
      checkedAtMs: now,
      title: indexedTitle,
      authoritative: true
    });
  }

  const refreshes = sessions
    .map((session) => ({ session, key: updateKey(session) }))
    .filter(({ session, key }) => shouldRefresh(
      cache.get(session.session_id),
      key,
      now,
      refreshIntervalMs
    ));

  await runWithConcurrency(refreshes, concurrency, async ({ session, key }) => {
    const previous = cache.get(session.session_id);
    try {
      const result = await fetchThread(session.session_id);
      const currentTitle = currentThreadTitle(result, { maxTitleBytes });
      cache.set(session.session_id, {
        updateKey: key,
        checkedAtMs: now,
        title: currentTitle || previous?.title || cleanTitle(session.title, maxTitleBytes),
        authoritative: Boolean(currentTitle)
          || previous?.authoritative === true
          || session.title_is_authoritative === true,
        ...(!currentTitle && previous?.authoritative !== true
          ? { failedUpdateKey: key, retryAtMs: now + retryDelayMs }
          : {})
      });
    } catch {
      cache.set(session.session_id, {
        ...previous,
        checkedAtMs: now,
        title: previous?.title || cleanTitle(session.title, maxTitleBytes),
        authoritative: previous?.authoritative === true
          || session.title_is_authoritative === true,
        failedUpdateKey: key,
        retryAtMs: now + retryDelayMs
      });
    }
  });

  return sessions.map((session) => ({
    ...session,
    title: cache.get(session.session_id)?.title || cleanTitle(session.title, maxTitleBytes),
    title_is_authoritative: cache.get(session.session_id)?.authoritative === true
  }));
}
