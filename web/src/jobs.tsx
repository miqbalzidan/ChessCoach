import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { inSnapshotMode } from './snapshot';
import type { Job } from './types';

/**
 * The one import or analysis running in the background, watched from the app shell
 * rather than from whichever screen started it.
 *
 * A job outlives the screen that started it — you start "analyse pending" in
 * Settings and go and look at the sheet — so its progress lives in the masthead and
 * every screen hears when another game has been analysed, instead of showing what it
 * fetched before the job started until someone reloads.
 */
interface JobTracker {
  /** The job being watched, kept for a moment after it finishes so its end is seen. */
  job: Job | null;
  /** Bumps whenever the job has changed what is stored. Screens refetch on it. */
  revision: number;
  /** Start watching a job a screen has just created. */
  track: (jobId: number) => Promise<Job | null>;
}

const JobContext = createContext<JobTracker>({
  job: null,
  revision: 0,
  track: async () => null,
});

export function useJobs(): JobTracker {
  return useContext(JobContext);
}

export function isActive(
  job: Job | null,
): job is Job & { status: 'queued' | 'running' } {
  return job !== null && job.status !== 'done' && job.status !== 'error';
}

const POLL_MS = 1000;
/** Refetching the sheet per game would mean a request storm on a fast engine. */
const REFRESH_MS = 4000;
/** How long a finished job stays in the masthead. */
const LINGER_MS = 6000;

export function JobProvider({
  username,
  onSettled,
  children,
}: {
  username: string | null;
  onSettled: () => void;
  children: React.ReactNode;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [revision, setRevision] = useState(0);
  const lastRefresh = useRef(0);
  const lastProgress = useRef('');

  const bump = useCallback((force: boolean) => {
    const now = Date.now();
    if (!force && now - lastRefresh.current < REFRESH_MS) return;
    lastRefresh.current = now;
    setRevision((current) => current + 1);
  }, []);

  const track = useCallback(async (jobId: number) => {
    try {
      const { job: started } = await api.job(jobId);
      lastProgress.current = `${started.imported}/${started.analysed}`;
      setJob(started);
      return started;
    } catch {
      return null;
    }
  }, []);

  // A job started before a reload is still running on the server; pick it back up.
  useEffect(() => {
    if (!username || inSnapshotMode()) return;
    let cancelled = false;
    api
      .latestJob(username)
      .then(({ job: latest }) => {
        if (!cancelled && isActive(latest)) void track(latest.id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [username, track]);

  const activeId = isActive(job) ? job.id : null;

  useEffect(() => {
    if (activeId === null) return;
    const timer = window.setInterval(async () => {
      try {
        const { job: next } = await api.job(activeId);
        setJob(next);
        const progress = `${next.imported}/${next.analysed}`;
        if (!isActive(next)) {
          bump(true);
          onSettled();
        } else if (progress !== lastProgress.current) {
          bump(false);
        }
        lastProgress.current = progress;
      } catch {
        // Keep the last known state; the next tick may succeed.
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [activeId, bump, onSettled]);

  // A finished job says so briefly, then gets out of the way.
  useEffect(() => {
    if (!job || isActive(job)) return;
    const timer = window.setTimeout(() => setJob(null), LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [job]);

  return <JobContext.Provider value={{ job, revision, track }}>{children}</JobContext.Provider>;
}

/** What a job is doing, in the words the masthead and Settings both use. */
export function describeJob(job: Job): string {
  if (job.status === 'error') return job.message ?? 'Failed';
  if (job.status === 'done') {
    if (job.total === 0) return 'Nothing pending — every game is analysed';
    return `Analysed ${job.analysed} of ${job.total}`;
  }
  switch (job.stage) {
    case 'fetching':
      return 'Fetching games';
    case 'importing':
      return job.total > 0 ? `Importing ${job.imported} of ${job.total}` : 'Importing';
    case 'analysing':
      return job.total > 0 ? `Analysing ${job.analysed} of ${job.total}` : 'Analysing';
    default:
      return 'Starting';
  }
}

/** 0–1, or null when there is no count to show yet. */
export function jobFraction(job: Job): number | null {
  if (job.status === 'done') return 1;
  if (job.total <= 0) return null;
  const count = job.stage === 'importing' ? job.imported : job.analysed;
  return Math.min(1, count / job.total);
}
