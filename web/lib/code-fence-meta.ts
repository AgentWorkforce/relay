export interface CodeFenceMeta {
  language: string;
  label?: string;
  filename?: string;
}

const META_PREFIX = 'ar-meta__';
const LANGUAGE_CLASS_PREFIX = 'language-';

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function encodeCodeFenceMeta({ language, label, filename }: CodeFenceMeta): string {
  const params = new URLSearchParams();
  params.set('lang', language);

  if (label) {
    params.set('label', label);
  }

  if (filename) {
    params.set('file', filename);
  }

  return `${META_PREFIX}${params.toString()}`;
}

function parseLegacyMetaPayload(payload: string): Record<string, string> {
  return payload.split('__').reduce<Record<string, string>>((acc, segment) => {
    const separator = segment.indexOf('=');
    if (separator === -1) {
      return acc;
    }

    const key = segment.slice(0, separator);
    const value = segment.slice(separator + 1);
    if (!key || !value) {
      return acc;
    }

    acc[key] = safeDecode(value);
    return acc;
  }, {});
}

export function parseCodeFenceMetaToken(token: string): CodeFenceMeta {
  if (!token.startsWith(META_PREFIX)) {
    return { language: token };
  }

  const payload = token.slice(META_PREFIX.length);
  const meta = payload.includes('&')
    ? Object.fromEntries(new URLSearchParams(payload).entries())
    : parseLegacyMetaPayload(payload);

  return {
    language: meta.lang || 'text',
    label: meta.label,
    filename: meta.file,
  };
}

export function extractCodeFenceToken(className?: string): string | undefined {
  const languageClasses = className
    ?.split(/\s+/)
    .filter((value) => value.startsWith(LANGUAGE_CLASS_PREFIX))
    .map((value) => value.slice(LANGUAGE_CLASS_PREFIX.length));

  return languageClasses?.find((value) => value.startsWith(META_PREFIX)) ?? languageClasses?.[0];
}

export function humanizeCodeFenceLanguage(language: string): string {
  const normalized = language.toLowerCase();
  const knownLabels: Record<string, string> = {
    ts: 'TypeScript',
    typescript: 'TypeScript',
    js: 'JavaScript',
    javascript: 'JavaScript',
    jsx: 'JSX',
    tsx: 'TSX',
    py: 'Python',
    python: 'Python',
    bash: 'Bash',
    sh: 'Shell',
    shell: 'Shell',
    yaml: 'YAML',
    yml: 'YAML',
    json: 'JSON',
    swift: 'Swift',
  };

  return knownLabels[normalized] ?? language;
}

export function getCodeFenceBadgeLabel(language: string, filename?: string): string {
  const extension = filename?.split('/').pop()?.split('.').pop()?.toLowerCase();
  const normalized = extension || language.toLowerCase();
  const knownBadges: Record<string, string> = {
    ts: 'TS',
    tsx: 'TS',
    js: 'JS',
    jsx: 'JS',
    py: 'PY',
    bash: 'SH',
    sh: 'SH',
    shell: 'SH',
    yaml: 'YML',
    yml: 'YML',
    json: 'JSON',
    swift: 'SW',
    md: 'MD',
    mdx: 'MDX',
    toml: 'TOML',
  };

  if (knownBadges[normalized]) {
    return knownBadges[normalized];
  }

  return normalized.slice(0, 4).toUpperCase();
}
