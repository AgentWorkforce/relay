function oneLine(value) {
  return String(value ?? 'unknown failure')
    .replace(/\s+/g, ' ')
    .trim();
}

function bounded(value, limit = 180) {
  const line = oneLine(value);
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

const SUMMARY_BYTE_LIMIT = 900;

function fitsSummary(value) {
  return Buffer.byteLength(value, 'utf8') <= SUMMARY_BYTE_LIMIT;
}

export function redactFailureMessage(value) {
  return oneLine(value)
    .replace(
      /(?:rk_live_|rjt_live_|at_live_|nt_live_|ot_live_|cld_at_|rth_at_|ocl_node_enr_|arr_live_|br_)[A-Za-z0-9._~+/=%-]+/g,
      '[REDACTED_RELAY_CREDENTIAL]'
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED_RELAY_CREDENTIAL]');
}

export default async function* failureSummary(source) {
  const failures = [];

  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const error = event.data?.details?.error;
    failures.push({
      name: bounded(redactFailureMessage(event.data?.name), 120),
      message: bounded(redactFailureMessage(error?.message)),
    });
  }

  if (failures.length === 0) return;
  let output = `FAILURE_SUMMARY count=${failures.length}\n`;
  let named = 0;
  for (const failure of failures) {
    const line = `FAIL ${failure.name}\n`;
    const omittedAfter = failures.length - named - 1;
    const footer = omittedAfter > 0 ? `OMITTED_FAILURES count=${omittedAfter}\n` : '';
    if (!fitsSummary(output + line + footer)) break;
    output += line;
    named += 1;
  }
  if (named < failures.length) {
    output += `OMITTED_FAILURES count=${failures.length - named}\n`;
  }

  let detailed = 0;
  for (const failure of failures.slice(0, named)) {
    const line = `DETAIL ${failure.name}: ${failure.message}\n`;
    const omittedAfter = named - detailed - 1;
    const footer = omittedAfter > 0 ? `OMITTED_DETAILS count=${omittedAfter}\n` : '';
    if (!fitsSummary(output + line + footer)) break;
    output += line;
    detailed += 1;
  }
  if (detailed < named) {
    output += `OMITTED_DETAILS count=${named - detailed}\n`;
  }
  yield output;
}
