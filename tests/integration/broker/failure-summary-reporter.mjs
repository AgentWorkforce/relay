function oneLine(value) {
  return String(value ?? 'unknown failure')
    .replace(/\s+/g, ' ')
    .trim();
}

export default async function* failureSummary(source) {
  const failures = [];

  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const error = event.data?.details?.error;
    failures.push({
      name: oneLine(event.data?.name),
      message: oneLine(error?.message),
    });
  }

  if (failures.length === 0) return;
  yield `FAILURE_SUMMARY count=${failures.length}\n`;
  for (const failure of failures) {
    yield `FAIL ${failure.name}: ${failure.message}\n`;
  }
}
