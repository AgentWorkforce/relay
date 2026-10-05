function oneLine(value) {
  return String(value ?? 'unknown failure')
    .replace(/\s+/g, ' ')
    .trim();
}

export function redactFailureMessage(value) {
  return oneLine(value)
    .replace(/\b(?:rk|at|br|arr)_live_[A-Za-z0-9._~-]+\b/g, '[REDACTED_RELAY_CREDENTIAL]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED_RELAY_CREDENTIAL]');
}

export default async function* failureSummary(source) {
  const failures = [];

  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const error = event.data?.details?.error;
    failures.push({
      name: oneLine(event.data?.name),
      message: redactFailureMessage(error?.message),
    });
  }

  if (failures.length === 0) return;
  yield `FAILURE_SUMMARY count=${failures.length}\n`;
  for (const failure of failures) {
    yield `FAIL ${failure.name}: ${failure.message}\n`;
  }
}
