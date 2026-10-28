import path from 'node:path';
import { CONFIG_FILENAME, readConfigFile } from '../config/zikiConfig.js';
import { describeFileReason } from '../config/reasons.js';
import { detectChecks } from '../detect/checks.js';

const RESULT_VALUES = new Set(['passed', 'failed', 'unknown']);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function detectedItems(root) {
  return detectChecks(root).map((check) => ({
    name: check.name,
    command: check.command,
    source: check.source,
    origin: 'detected',
  }));
}

function configuredItems(doc) {
  return doc.checks.map((check) => ({
    name: check.name,
    command: check.command,
    source: check.source,
    origin: 'ziki.json',
  }));
}

function observationTime(record) {
  if (!isPlainObject(record) || typeof record.observedAt !== 'string') {
    return null;
  }
  if (!ISO_UTC.test(record.observedAt)) {
    return null;
  }
  const value = Date.parse(record.observedAt);
  return Number.isNaN(value) ? null : value;
}

/**
 * Match a recorded observation to one configured check. Matching is by
 * name+source; the command must also match exactly. A mismatch is reported as
 * unknown instead of being silently ignored.
 */
function resolveObservation(check, records, currentTime) {
  const now = currentTime instanceof Date ? currentTime.getTime() : currentTime;
  const candidates = records.filter(
    (record) =>
      isPlainObject(record) &&
      record.name === check.name &&
      record.source === check.source,
  );

  if (candidates.length === 0) {
    return { state: 'not run', observed: null, detail: null };
  }

  // Latest valid timestamp wins. Malformed entries sort last; they only
  // produce an unknown detail when no valid candidate exists.
  const ordered = [...candidates].sort((left, right) => {
    const leftTime = observationTime(left);
    const rightTime = observationTime(right);
    if (leftTime === null && rightTime === null) {
      return 0;
    }
    if (leftTime === null) {
      return 1;
    }
    if (rightTime === null) {
      return -1;
    }
    return rightTime - leftTime;
  });
  const record = ordered[0];

  if (!isPlainObject(record)) {
    return {
      state: 'unknown',
      observed: null,
      detail: 'the recorded observation is not an object',
    };
  }

  if (typeof record.command !== 'string' || record.command !== check.command) {
    return {
      state: 'unknown',
      observed: null,
      detail: 'the recorded observation is for a different command',
    };
  }

  if (!RESULT_VALUES.has(record.result)) {
    return {
      state: 'unknown',
      observed: null,
      detail: 'the recorded observation has an invalid result',
    };
  }

  const time = observationTime(record);
  if (time === null) {
    return {
      state: 'unknown',
      observed: null,
      detail: 'the recorded observation has an invalid timestamp',
    };
  }

  if (time > now + MAX_FUTURE_SKEW_MS) {
    return {
      state: 'unknown',
      observed: null,
      detail: 'the recorded observation is in the future',
    };
  }

  if (
    record.exitCode !== undefined &&
    record.exitCode !== null &&
    !Number.isInteger(record.exitCode)
  ) {
    return {
      state: 'unknown',
      observed: null,
      detail: 'the recorded observation has an invalid exit code',
    };
  }

  const exitCode = record.exitCode ?? null;
  if (record.result === 'passed' && exitCode !== null && exitCode !== 0) {
    return {
      state: 'unknown',
      observed: null,
      detail: 'the recorded observation is contradictory (passed with a non-zero exit code)',
    };
  }
  if (record.result === 'failed' && exitCode === 0) {
    return {
      state: 'unknown',
      observed: null,
      detail: 'the recorded observation is contradictory (failed with exit code 0)',
    };
  }

  if (record.result === 'unknown') {
    return {
      state: 'unknown',
      observed: null,
      detail: 'the recorded observation has no result',
    };
  }

  return {
    state: 'observed',
    observed: {
      result: record.result,
      exitCode,
      observedAt: record.observedAt,
      recordedIn: 'ziki.json#lastObserved',
    },
    detail: null,
  };
}

/**
 * Resolve the displayed check list and state. `review` is read-only: it never
 * writes `ziki.json` and never upgrades a recorded observation into a claim
 * that Ziki ran or verified the command.
 */
export function collectChecks({ root, now = Date.now() } = {}) {
  const currentTime = now instanceof Date ? now.getTime() : now;
  const config = readConfigFile(path.join(root, CONFIG_FILENAME));
  const warnings = [];

  if (config.kind !== 'valid') {
    const detected = detectedItems(root);
    const absent = config.kind === 'absent';
    const reason = absent ? null : describeFileReason(config.kind);
    const detail = absent
      ? 'ziki.json not found; checks were detected from project manifests'
      : `ziki.json could not be used (${reason}); checks were detected from project manifests`;

    if (!absent) {
      warnings.push({
        code: 'config-unusable',
        message: detail,
      });
    }

    return {
      checks: {
        source: 'detected',
        detail,
        items: detected.map((item) => ({
          ...item,
          state: absent ? 'not run' : 'unknown',
          observed: null,
          detail: absent ? null : 'the configured check list is unavailable',
        })),
      },
      warnings,
    };
  }

  if (config.hasIntegrity && !config.integrityValid) {
    warnings.push({
      code: 'config-integrity-mismatch',
      message:
        'ziki.json does not match its recorded integrity hash; recorded observations were not verified',
    });
  }

  const items = configuredItems(config.doc);
  const observations = config.doc.lastObserved;

  if (observations === undefined) {
    return {
      checks: {
        source: 'ziki.json',
        detail: null,
        items: items.map((item) => ({
          ...item,
          state: 'not run',
          observed: null,
          detail: null,
        })),
      },
      warnings,
    };
  }

  if (!Array.isArray(observations)) {
    warnings.push({
      code: 'last-observed-invalid',
      message: 'ziki.json lastObserved is not an array; recorded check state is unknown',
    });
    return {
      checks: {
        source: 'ziki.json',
        detail: 'lastObserved is not an array',
        items: items.map((item) => ({
          ...item,
          state: 'unknown',
          observed: null,
          detail: 'lastObserved is not an array',
        })),
      },
      warnings,
    };
  }

  const matched = new Set();
  const resolved = items.map((item) => {
    for (const record of observations) {
      if (
        isPlainObject(record) &&
        record.name === item.name &&
        record.source === item.source
      ) {
        matched.add(record);
      }
    }
    return {
      ...item,
      ...resolveObservation(item, observations, currentTime),
    };
  });

  const malformed = observations.filter((record) => !isPlainObject(record)).length;
  if (malformed > 0) {
    warnings.push({
      code: 'observations-invalid',
      message: `${malformed} recorded observation${malformed === 1 ? '' : 's'} were not valid objects`,
    });
  }

  const unmatched = observations.filter(
    (record) => isPlainObject(record) && !matched.has(record),
  ).length;
  if (unmatched > 0) {
    warnings.push({
      code: 'observations-unmatched',
      message: `${unmatched} recorded observation${unmatched === 1 ? '' : 's'} did not match a configured check`,
    });
  }

  return {
    checks: {
      source: 'ziki.json',
      detail: null,
      items: resolved,
    },
    warnings,
  };
}
