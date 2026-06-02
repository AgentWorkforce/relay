/**
 * Shared building blocks for Agent Relay's dynamically generated Open Graph
 * cards (next/og + satori, 1200x630). This module is NOT a route — the route
 * files (`app/opengraph-image.tsx`, `app/og-home/route.tsx`, the blog and docs
 * `opengraph-image.tsx`) import these helpers so every card shares one frame,
 * one palette, and one font/logo treatment.
 *
 * Satori constraints respected throughout: flexbox only (no grid), every node
 * carries an explicit `display`, every text node has a flex parent, and SVG/img
 * elements have explicit width/height.
 */
import type { ReactElement } from 'react';

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = 'image/png';

// Brand palette (dark theme), hardcoded because satori cannot read CSS vars.
export const PALETTE = {
  bg: '#08111A',
  surface: '#0F1B29',
  fg: '#EDF4FB',
  muted: '#A8B8C8',
  faint: '#77879A',
  primary: '#74B8E2',
  primaryHover: '#94CBEF',
  mention: '#58A6FF',
  line: 'rgba(116, 184, 226, 0.18)',
  green: '#28C840',
  terracotta: '#C1674B',
  // Resolved .previewAccent gradient end (~80% terracotta over the dark bg).
  terracottaDeep: '#A8543B',
} as const;

const HEADING_FAMILY_FALLBACK = 'sans-serif';
const BODY_FAMILY_FALLBACK = 'sans-serif';

export type LoadedFonts = {
  fonts: { name: string; data: ArrayBuffer; weight: 400 | 500 | 700 | 800; style: 'normal' }[];
  headingFamily: string;
  bodyFamily: string;
};

/**
 * Full glyph set requested from Google Fonts so every rendered character — the
 * uppercase letters produced by `text-transform: uppercase`, digits, and every
 * punctuation mark we emit (em/en dash, curly apostrophe, arrow, middot, hash,
 * at, slash, ampersand, percent, parens) — is present in the downloaded subset.
 * A missing glyph silently falls back to satori's default font, which would
 * break the typography, so the subset must be exhaustive for what we render.
 */
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;!?\'’"#·—–-→@()/&%';

/**
 * Fetch a Google Font for embedding into the OG image.
 *
 * next/og (satori) cannot resolve `next/font` output, and the brand fonts (Sora
 * for headings, Inter for body) ship only as Google Fonts. The documented
 * next/og pattern is to fetch the static TTF at render time. We fail soft: on
 * any network/parse failure we return null so the caller can render with
 * satori's default font instead of throwing.
 */
async function loadGoogleFont(family: string, weight: number, text: string): Promise<ArrayBuffer | null> {
  try {
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
      family
    )}:wght@${weight}&text=${encodeURIComponent(text)}`;
    const cssResponse = await fetch(url, {
      headers: {
        // Avoid modern Chrome UA strings here: Google Fonts returns woff2,
        // which satori cannot parse. This older WebKit UA returns woff.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
      },
    });
    if (!cssResponse.ok) return null;
    const css = await cssResponse.text();
    const match = css.match(/src:\s*url\(([^)]+)\)(?:\s*format\(['"]?([^'")]+)['"]?\))?/);
    const format = match?.[2];
    if (format && !['truetype', 'opentype', 'woff'].includes(format)) return null;
    const fontUrl = match?.[1];
    if (!fontUrl) return null;
    const fontResponse = await fetch(fontUrl);
    if (!fontResponse.ok) return null;
    return await fontResponse.arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * Load the brand fonts (Sora 700/800 heading, Inter 400/500 body) for an
 * ImageResponse. Returns the satori `fonts` array plus the resolved family
 * names to use in styles. Fails soft: any font that fails to download is simply
 * omitted and its fallback family name is used instead. Sora 800 backs the
 * heavier all-white landing hero; the rest fall back to 700 if it is missing.
 */
export async function loadBrandFonts(): Promise<LoadedFonts> {
  const [soraBold, soraExtraBold, interRegular, interMedium] = await Promise.all([
    loadGoogleFont('Sora', 700, GLYPHS),
    loadGoogleFont('Sora', 800, GLYPHS),
    loadGoogleFont('Inter', 400, GLYPHS),
    loadGoogleFont('Inter', 500, GLYPHS),
  ]);

  const fonts: LoadedFonts['fonts'] = [];
  if (soraBold) fonts.push({ name: 'Sora', data: soraBold, weight: 700, style: 'normal' });
  if (soraExtraBold) fonts.push({ name: 'Sora', data: soraExtraBold, weight: 800, style: 'normal' });
  if (interRegular) fonts.push({ name: 'Inter', data: interRegular, weight: 400, style: 'normal' });
  if (interMedium) fonts.push({ name: 'Inter', data: interMedium, weight: 500, style: 'normal' });

  return {
    fonts,
    headingFamily: soraBold || soraExtraBold ? 'Sora' : HEADING_FAMILY_FALLBACK,
    bodyFamily: interRegular || interMedium ? 'Inter' : BODY_FAMILY_FALLBACK,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Logo + wordmark lockup — reproduces the site header (SiteNav LogoIcon +
// LogoWordmark) using the exact path geometry, light on the dark background.
// ───────────────────────────────────────────────────────────────────────────

const LOGO_MARK_PATH_SOLID =
  'M71.3682 21.7098L54.042 39.036C50.6567 42.4213 50.6568 47.9099 54.042 51.2952L71.3727 68.6259L52.8321 87.1665C48.6005 91.3981 41.7397 91.3981 37.5081 87.1665L3.17369 52.8321C-1.05789 48.6005 -1.0579 41.7397 3.17369 37.5081L37.5081 3.17369C41.7397 -1.0579 48.6005 -1.05789 52.8321 3.17369L71.3682 21.7098Z';
const LOGO_MARK_PATH_GHOST =
  'M75.5711 72.8243C78.9563 76.2096 84.445 76.2096 87.8302 72.8243L109.359 51.2952C112.745 47.9099 112.745 42.4213 109.359 39.036L87.8302 17.507C84.445 14.1218 78.9563 14.1218 75.5711 17.507L71.3682 21.7098L88.6989 39.0405C92.0842 42.4258 92.0842 47.9144 88.6989 51.2997L71.3727 68.6259L75.5711 72.8243Z';
const LOGO_WORDMARK_PATH =
  'M74.7504 42.84C72.6304 42.84 70.7304 42.48 69.0504 41.76C67.4104 41.04 66.0904 39.98 65.0904 38.58C64.1304 37.18 63.6504 35.48 63.6504 33.48C63.6504 31.44 64.1304 29.76 65.0904 28.44C66.0904 27.08 67.4304 26.06 69.1104 25.38C70.8304 24.7 72.7704 24.36 74.9304 24.36H83.9304V22.44C83.9304 20.72 83.4104 19.34 82.3704 18.3C81.3304 17.26 79.7304 16.74 77.5704 16.74C75.4504 16.74 73.8304 17.24 72.7104 18.24C71.5904 19.24 70.8504 20.54 70.4904 22.14L64.7304 20.28C65.2104 18.68 65.9704 17.24 67.0104 15.96C68.0904 14.64 69.5104 13.58 71.2704 12.78C73.0304 11.98 75.1504 11.58 77.6304 11.58C81.4704 11.58 84.4904 12.56 86.6904 14.52C88.8902 16.48 89.9902 19.26 89.9902 22.86V35.04C89.9902 36.24 90.5502 36.84 91.6702 36.84H94.1902V42H89.5702C88.1702 42 87.0304 41.64 86.1504 40.92C85.2704 40.2 84.8304 39.22 84.8304 37.98V37.8H83.9304C83.6104 38.4 83.1304 39.1 82.4904 39.9C81.8504 40.7 80.9104 41.4 79.6704 42C78.4304 42.56 76.7904 42.84 74.7504 42.84ZM75.6504 37.74C78.1304 37.74 80.1304 37.04 81.6504 35.64C83.1704 34.2 83.9304 32.24 83.9304 29.76V29.16H75.2904C73.6504 29.16 72.3304 29.52 71.3304 30.24C70.3304 30.92 69.8304 31.94 69.8304 33.3C69.8304 34.66 70.3504 35.74 71.3904 36.54C72.4304 37.34 73.8504 37.74 75.6504 37.74ZM93.2562 27.36V26.46C93.2562 23.34 93.8762 20.68 95.1162 18.48C96.3962 16.28 98.0762 14.58 100.156 13.38C102.236 12.18 104.516 11.58 106.996 11.58C109.876 11.58 112.076 12.12 113.596 13.2C115.156 14.28 116.296 15.44 117.016 16.68H117.976V12.42H123.976V48.06C123.976 49.86 123.436 51.3 122.356 52.38C121.316 53.46 119.876 54 118.036 54H98.1162V48.6H116.116C117.276 48.6 117.856 48 117.856 46.8V37.38H116.896C116.456 38.1 115.836 38.84 115.036 39.6C114.236 40.36 113.176 40.98 111.856 41.46C110.576 41.94 108.956 42.18 106.996 42.18C104.516 42.18 102.216 41.6 100.096 40.44C98.0162 39.24 96.3562 37.54 95.1162 35.34C93.8762 33.1 93.2562 30.44 93.2562 27.36ZM108.676 36.78C111.356 36.78 113.556 35.94 115.276 34.26C117.036 32.54 117.916 30.18 117.916 27.18V26.64C117.916 23.56 117.056 21.2 115.336 19.56C113.616 17.88 111.396 17.04 108.676 17.04C106.036 17.04 103.836 17.88 102.076 19.56C100.356 21.2 99.4962 23.56 99.4962 26.64V27.18C99.4962 30.18 100.356 32.54 102.076 34.26C103.836 35.94 106.036 36.78 108.676 36.78ZM141.835 42.84C138.835 42.84 136.215 42.22 133.975 40.98C131.735 39.7 129.975 37.92 128.695 35.64C127.455 33.32 126.835 30.64 126.835 27.6V26.88C126.835 23.8 127.455 21.12 128.695 18.84C129.935 16.52 131.655 14.74 133.855 13.5C136.095 12.22 138.675 11.58 141.595 11.58C144.435 11.58 146.915 12.22 149.035 13.5C151.195 14.74 152.875 16.48 154.075 18.72C155.275 20.96 155.875 23.58 155.875 26.58V28.92H133.135C133.215 31.52 134.075 33.6 135.715 35.16C137.395 36.68 139.475 37.44 141.955 37.44C144.275 37.44 146.015 36.92 147.175 35.88C148.375 34.84 149.295 33.64 149.935 32.28L155.035 34.92C154.475 36.04 153.655 37.22 152.575 38.46C151.535 39.7 150.155 40.74 148.435 41.58C146.715 42.42 144.515 42.84 141.835 42.84ZM133.195 24.18H149.575C149.415 21.94 148.615 20.2 147.175 18.96C145.735 17.68 143.855 17.04 141.535 17.04C139.215 17.04 137.315 17.68 135.835 18.96C134.395 20.2 133.515 21.94 133.195 24.18ZM158.514 42V12.42H164.574V16.86H165.534C166.094 15.66 167.094 14.54 168.534 13.5C169.974 12.46 172.114 11.94 174.954 11.94C177.194 11.94 179.174 12.44 180.894 13.44C182.654 14.44 184.034 15.86 185.034 17.7C186.034 19.5 186.534 21.68 186.534 24.24V42H180.354V24.72C180.354 22.16 179.714 20.28 178.434 19.08C177.154 17.84 175.394 17.22 173.154 17.22C170.594 17.22 168.534 18.06 166.974 19.74C165.454 21.42 164.694 23.86 164.694 27.06V42H158.514ZM200.908 42C199.108 42 197.668 41.46 196.588 40.38C195.548 39.3 195.028 37.86 195.028 36.06V17.64H186.868V12.42H195.028V2.64H201.208V12.42H210.028V17.64H201.208V34.98C201.208 36.18 201.768 36.78 202.888 36.78H209.068V42H200.908ZM212.488 42V12.42H218.548V15.9H219.508C219.988 14.66 220.748 13.76 221.788 13.2C222.868 12.6 224.188 12.3 225.748 12.3H229.288V17.88H225.508C223.508 17.88 221.868 18.44 220.588 19.56C219.308 20.64 218.668 22.32 218.668 24.6V42H212.488ZM243.397 42.84C240.397 42.84 237.777 42.22 235.537 40.98C233.297 39.7 231.537 37.92 230.257 35.64C229.017 33.32 228.397 30.64 228.397 27.6V26.88C228.397 23.8 229.017 21.12 230.257 18.84C231.497 16.52 233.217 14.74 235.417 13.5C237.657 12.22 240.237 11.58 243.157 11.58C245.997 11.58 248.477 12.22 250.597 13.5C252.757 14.74 254.437 16.48 255.637 18.72C256.837 20.96 257.437 23.58 257.437 26.58V28.92H234.697C234.777 31.52 235.637 33.6 237.277 35.16C238.957 36.68 241.037 37.44 243.517 37.44C245.837 37.44 247.577 36.92 248.737 35.88C249.937 34.84 250.857 33.64 251.497 32.28L256.597 34.92C256.037 36.04 255.217 37.22 254.137 38.46C253.097 39.7 251.717 40.74 249.997 41.58C248.277 42.42 246.077 42.84 243.397 42.84ZM234.757 24.18H251.137C250.977 21.94 250.177 20.2 248.737 18.96C247.297 17.68 245.417 17.04 243.097 17.04C240.777 17.04 238.877 17.68 237.397 18.96C235.957 20.2 235.077 21.94 234.757 24.18ZM260.076 42V0H266.256V42H260.076ZM279.807 42.84C277.687 42.84 275.787 42.48 274.107 41.76C272.467 41.04 271.147 39.98 270.147 38.58C269.187 37.18 268.707 35.48 268.707 33.48C268.707 31.44 269.187 29.76 270.147 28.44C271.147 27.08 272.487 26.06 274.167 25.38C275.887 24.7 277.827 24.36 279.987 24.36H288.987V22.44C288.987 20.72 288.467 19.34 287.427 18.3C286.387 17.26 284.787 16.74 282.627 16.74C280.507 16.74 278.887 17.24 277.767 18.24C276.647 19.24 275.907 20.54 275.547 22.14L269.787 20.28C270.267 18.68 271.027 17.24 272.067 15.96C273.147 14.64 274.567 13.58 276.327 12.78C278.087 11.98 280.207 11.58 282.687 11.58C286.527 11.58 289.547 12.56 291.747 14.52C293.947 16.48 295.047 19.26 295.047 22.86V35.04C295.047 36.24 295.607 36.84 296.727 36.84H299.247V42H294.627C293.227 42 292.087 41.64 291.207 40.92C290.327 40.2 289.887 39.22 289.887 37.98V37.8H288.987C288.667 38.4 288.187 39.1 287.547 39.9C286.907 40.7 285.967 41.4 284.727 42C283.487 42.56 281.847 42.84 279.807 42.84ZM280.707 37.74C283.187 37.74 285.187 37.04 286.707 35.64C288.227 34.2 288.987 32.24 288.987 29.76V29.16H280.347C278.707 29.16 277.387 29.52 276.387 30.24C275.387 30.92 274.887 31.94 274.887 33.3C274.887 34.66 275.407 35.74 276.447 36.54C277.487 37.34 278.907 37.74 280.707 37.74ZM303.114 54V48.6H319.614C320.734 48.6 321.294 48 321.294 46.8V37.68H320.334C319.974 38.48 319.414 39.26 318.654 40.02C317.934 40.74 316.954 41.34 315.714 41.82C314.474 42.3 312.914 42.54 311.034 42.54C308.794 42.54 306.794 42.04 305.034 41.04C303.274 40.04 301.894 38.62 300.894 36.78C299.894 34.94 299.394 32.76 299.394 30.24V12.42H305.574V29.76C305.574 32.32 306.214 34.22 307.494 35.46C308.774 36.66 310.554 37.26 312.834 37.26C315.354 37.26 317.374 36.42 318.894 34.74C320.454 33.06 321.234 30.62 321.234 27.42V12.42H327.414V48.06C327.414 49.86 326.874 51.3 325.794 52.38C324.754 53.46 323.314 54 321.474 54H303.114Z';

/**
 * Brand lockup matching the site header: the two-path "relay" mark (solid
 * #75B8E2 + darker #3F6A86 ghost echo) next to the white "Agent Relay"
 * wordmark, on the dark background. `scale` lets variants render it a touch
 * larger or smaller while preserving the header's mark-to-wordmark proportions.
 */
export function BrandLockup({ scale = 1 }: { scale?: number }): ReactElement {
  const markHeight = 30 * scale;
  const markWidth = markHeight * (112 / 91);
  const wordHeight = 26 * scale;
  // Wordmark viewBox is "64 0 264 54" -> aspect 264/54.
  const wordWidth = wordHeight * (264 / 54);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 * scale }}>
      <svg
        width={markWidth}
        height={markHeight}
        viewBox="0 0 112 91"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: 'flex' }}
      >
        <path fillRule="evenodd" clipRule="evenodd" d={LOGO_MARK_PATH_SOLID} fill="#75B8E2" />
        <path d={LOGO_MARK_PATH_GHOST} fill="#3F6A86" />
      </svg>
      <svg
        width={wordWidth}
        height={wordHeight}
        viewBox="64 0 264 54"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: 'flex' }}
      >
        <path d={LOGO_WORDMARK_PATH} fill={PALETTE.fg} />
      </svg>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Decorative swoop lines — reuse the exact wavy path data from the landing page
// (capabilityDividerWaves) as thin, low-opacity flow lines.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Three nearly-horizontal wavy flow lines in primary blue at low opacity.
 * Positioned absolutely; pass a `top` offset (px from the canvas top) to place
 * the band, e.g. across the lower third of a card.
 */
export function SwoopLines({ top, opacity = 0.28 }: { top: number; opacity?: number }): ReactElement {
  return (
    <svg
      width="1200"
      height="160"
      viewBox="-120 0 1440 160"
      fill="none"
      style={{ position: 'absolute', left: 0, top, display: 'flex' }}
    >
      <g stroke={PALETTE.primary} strokeWidth="1.4" strokeLinecap="round" opacity={opacity}>
        <path d="M-120 84 C120 42 318 46 560 70 S928 106 1320 24" />
        <path d="M-120 104 C136 60 336 66 580 88 S948 122 1320 46" opacity="0.7" />
        <path d="M-120 64 C112 24 310 28 540 52 S902 86 1320 8" opacity="0.5" />
      </g>
    </svg>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Shared frame — the dark brand background with layered gradient washes.
// ───────────────────────────────────────────────────────────────────────────

const FRAME_BACKGROUND_IMAGE =
  'radial-gradient(900px 540px at 6% -12%, rgba(116,184,226,0.20) 0%, transparent 60%), ' +
  'radial-gradient(720px 500px at 106% 116%, rgba(116,184,226,0.10) 0%, transparent 55%), ' +
  'linear-gradient(165deg, #0B1A29 0%, #08111A 55%, #060D15 100%)';

export function Frame({
  bodyFamily,
  children,
}: {
  bodyFamily: string;
  children: ReactElement | ReactElement[];
}): ReactElement {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        position: 'relative',
        overflow: 'hidden',
        background: PALETTE.bg,
        backgroundImage: FRAME_BACKGROUND_IMAGE,
        fontFamily: bodyFamily,
      }}
    >
      {children}
    </div>
  );
}

const HERO_FONT_SIZE_DEFAULT = 76;

/**
 * The hero headline "Headless Slack for Agents".
 *
 * By default the second line ("for Agents") renders in primary blue, matching
 * the live two-tone hero used on the default/docs/blog cards. The landing card
 * passes `accent={false}` to render the full headline in white, and bumps
 * `fontWeight` for a heavier, more solid Sora bold.
 */
export function HeroHeadline({
  headingFamily,
  fontSize = HERO_FONT_SIZE_DEFAULT,
  accent = true,
  fontWeight = 700,
}: {
  headingFamily: string;
  fontSize?: number;
  /** When false, the whole headline is white (no blue on "for Agents"). */
  accent?: boolean;
  /** Sora weight for the headline. */
  fontWeight?: 700 | 800;
}): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        fontFamily: headingFamily,
        fontWeight,
        fontSize,
        lineHeight: 1.0,
        letterSpacing: '-0.045em',
        color: PALETTE.fg,
      }}
    >
      <span style={{ display: 'flex', fontWeight }}>Headless Slack</span>
      <span style={{ display: 'flex', fontWeight, color: accent ? PALETTE.primary : PALETTE.fg }}>
        for Agents
      </span>
    </div>
  );
}

const SUBTITLE =
  'Channels, threads, DMs, reactions, and real-time events — everything you’d expect from Slack, exposed as an SDK.';

// ───────────────────────────────────────────────────────────────────────────
// Variant: DEFAULT — logo + wordmark, hero headline, subtitle, swoop band.
// Used by the site-wide fallback OG and by doc pages.
// ───────────────────────────────────────────────────────────────────────────

export function DefaultVariant({
  headingFamily,
  bodyFamily,
  title,
  subtitle = SUBTITLE,
  eyebrow,
}: {
  headingFamily: string;
  bodyFamily: string;
  /** Optional override headline. When set, replaces the two-line hero. */
  title?: string;
  subtitle?: string;
  /** Optional small uppercase label above the headline (e.g. "Documentation"). */
  eyebrow?: string;
}): ReactElement {
  return (
    <Frame bodyFamily={bodyFamily}>
      <SwoopLines top={392} opacity={0.26} />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          padding: '0 88px',
          position: 'relative',
        }}
      >
        <div style={{ display: 'flex', position: 'absolute', top: 64, left: 88 }}>
          <BrandLockup scale={1.4} />
        </div>

        {eyebrow ? (
          <div
            style={{
              display: 'flex',
              alignSelf: 'flex-start',
              padding: '8px 16px',
              borderRadius: 999,
              background: 'rgba(116,184,226,0.12)',
              border: `1px solid ${PALETTE.line}`,
              color: PALETTE.primaryHover,
              fontSize: 18,
              fontWeight: 500,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              marginBottom: 26,
            }}
          >
            {eyebrow}
          </div>
        ) : null}

        {title ? (
          <div
            style={{
              display: 'flex',
              fontFamily: headingFamily,
              fontWeight: 700,
              fontSize: 64,
              lineHeight: 1.05,
              letterSpacing: '-0.04em',
              color: PALETTE.fg,
              maxWidth: 940,
            }}
          >
            {title}
          </div>
        ) : (
          <HeroHeadline headingFamily={headingFamily} accent={false} />
        )}

        <div
          style={{
            display: 'flex',
            fontSize: 26,
            lineHeight: 1.5,
            color: PALETTE.muted,
            marginTop: 28,
            maxWidth: 760,
          }}
        >
          {subtitle}
        </div>
      </div>
    </Frame>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Provider glyphs — authentic brand marks inlined for satori.
//
// Satori cannot run the React component in `components/AgentToolLogos.tsx`
// (className/gradient/idPrefix logic), so the exact <path>/<rect> geometry and
// brand colors are inlined here. Source mapping:
//   - Claude    → AgentToolLogos ClaudeLogo path, fill #C1674B (terracotta burst)
//   - Codex     → simple-icons "openai" swirl path, light gray #A8B0BD
//   - Gemini    → AgentToolLogos GeminiLogo 4-point spark path, brand blue
//   - OpenCode  → AgentToolLogos OpenCodeLogo stacked rects (#F5F4F0/#7A7A72/#5A5A54)
// ───────────────────────────────────────────────────────────────────────────

const GLYPH_TILE = 26;
const GLYPH_INNER = 17;

function GlyphTile({
  bg,
  scale = 1,
  children,
}: {
  bg: string;
  scale?: number;
  children: ReactElement;
}): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: GLYPH_TILE * scale,
        height: GLYPH_TILE * scale,
        borderRadius: 7 * scale,
        flexShrink: 0,
        background: bg,
      }}
    >
      {children}
    </div>
  );
}

const CLAUDE_GLYPH_PATH =
  'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z';

// simple-icons "openai" swirl, rendered in light gray to read as Codex.
const CODEX_GLYPH_PATH =
  'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.5125 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';

// AgentToolLogos GeminiLogo 4-point spark.
const GEMINI_GLYPH_PATH =
  'M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z';

function ClaudeGlyph({ scale = 1 }: { scale?: number }): ReactElement {
  return (
    <GlyphTile bg="#1F1B17" scale={scale}>
      <svg width={GLYPH_INNER * scale} height={GLYPH_INNER * scale} viewBox="0 0 24 24" fill="none">
        <path d={CLAUDE_GLYPH_PATH} fill={PALETTE.terracotta} />
      </svg>
    </GlyphTile>
  );
}

function CodexGlyph({ scale = 1 }: { scale?: number }): ReactElement {
  return (
    <GlyphTile bg="#0B0B0B" scale={scale}>
      <svg width={GLYPH_INNER * scale} height={GLYPH_INNER * scale} viewBox="0 0 24 24" fill="none">
        <path d={CODEX_GLYPH_PATH} fill="#A8B0BD" />
      </svg>
    </GlyphTile>
  );
}

function GeminiGlyph({ scale = 1 }: { scale?: number }): ReactElement {
  return (
    <GlyphTile bg="#0B1020" scale={scale}>
      <svg width={GLYPH_INNER * scale} height={GLYPH_INNER * scale} viewBox="0 0 24 24" fill="none">
        <path d={GEMINI_GLYPH_PATH} fill="#3186FF" />
      </svg>
    </GlyphTile>
  );
}

function OpenCodeGlyph({ scale = 1 }: { scale?: number }): ReactElement {
  return (
    <GlyphTile bg="#1A1A17" scale={scale}>
      <svg width={GLYPH_INNER * scale} height={GLYPH_INNER * scale} viewBox="0 0 24 24" fill="none">
        <rect x="4" y="2" width="16" height="20" fill="#7A7A72" />
        <rect x="8" y="6" width="8" height="6" fill="#F5F4F0" />
        <rect x="8" y="12" width="8" height="7" fill="#5A5A54" />
      </svg>
    </GlyphTile>
  );
}

type ToolId = 'claude' | 'codex' | 'gemini' | 'opencode';

function ToolGlyph({ tool, scale = 1 }: { tool: ToolId; scale?: number }): ReactElement {
  if (tool === 'claude') return <ClaudeGlyph scale={scale} />;
  if (tool === 'codex') return <CodexGlyph scale={scale} />;
  if (tool === 'gemini') return <GeminiGlyph scale={scale} />;
  return <OpenCodeGlyph scale={scale} />;
}

// ───────────────────────────────────────────────────────────────────────────
// Variant: LANDING — left copy column + right chat panel.
//
// The chat panel reproduces the homepage "real-time messaging SDK" preview
// (ChannelMessagesPreview styled by app/landing.module.css): a terracotta
// accent frame (.previewAccent, with the faint white diagonal-line texture)
// behind a dark card (.previewChat, asymmetric radius + heavier border) holding
// the channel header, a threaded reply, message cards with real provider
// glyphs, a reaction pill, and a composer. All var()/color-mix() resolved to
// concrete dark-theme hex since satori cannot use CSS vars.
//
// The screenshot shows three agents (Claude/OpenCode/Codex); the layout keeps
// those three. A Gemini glyph is also inlined above for completeness/optional
// use, but is not placed so the panel matches the screenshot exactly.
// ───────────────────────────────────────────────────────────────────────────

type ChatMessagePart = { text: string; mention?: boolean };

type ChatMessage = {
  tool: ToolId;
  name: string;
  parts: ChatMessagePart[];
  reaction?: { emoji: string; count: string };
};

const LANDING_MESSAGES: ChatMessage[] = [
  {
    tool: 'claude',
    name: 'Planner',
    parts: [{ text: '@reviewer', mention: true }, { text: 'do you want Sentry in the same test set?' }],
  },
  {
    tool: 'opencode',
    name: 'Reviewer',
    parts: [{ text: 'Yes, include Sentry and one malformed payload.' }],
    reaction: { emoji: '✅', count: '1' },
  },
  {
    tool: 'codex',
    name: 'Builder',
    parts: [{ text: 'Parser now handles nested fields and bad payload errors.' }],
  },
  {
    tool: 'claude',
    name: 'Planner',
    parts: [{ text: 'Shipping the updated plan to #dev.' }],
  },
];

function ChatMessageCard({ message, scale = 1 }: { message: ChatMessage; scale?: number }): ReactElement {
  return (
    // .chatMsg — each message is its own bordered rounded card.
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: `${10 * scale}px ${12 * scale}px`,
        borderRadius: 10 * scale,
        background: 'rgba(8,17,26,0.55)',
        border: `1px solid ${PALETTE.line}`,
        gap: 5 * scale,
      }}
    >
      {/* .chatNameRow */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 * scale }}>
        <ToolGlyph tool={message.tool} scale={scale} />
        <span style={{ display: 'flex', fontSize: 14 * scale, fontWeight: 700, color: PALETTE.fg }}>
          {message.name}
        </span>
      </div>
      {/* .chatText */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          fontSize: 14 * scale,
          lineHeight: 1.4,
          paddingLeft: 34 * scale,
        }}
      >
        {message.parts.map((part, i) =>
          part.mention ? (
            <span
              key={i}
              style={{ display: 'flex', color: PALETTE.mention, fontWeight: 500, marginRight: 5 * scale }}
            >
              {part.text}
            </span>
          ) : (
            <span key={i} style={{ display: 'flex', color: PALETTE.muted }}>
              {part.text}
            </span>
          )
        )}
      </div>
      {message.reaction ? (
        // .chatReactions / .chatReaction
        <div style={{ display: 'flex', paddingLeft: 34 * scale }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5 * scale,
              padding: `${2 * scale}px ${8 * scale}px`,
              borderRadius: 999,
              background: 'rgba(8,17,26,0.8)',
              border: `1px solid ${PALETTE.line}`,
            }}
          >
            <span style={{ display: 'flex', fontSize: 13 * scale }}>{message.reaction.emoji}</span>
            <span style={{ display: 'flex', fontSize: 12 * scale, color: PALETTE.muted }}>
              {message.reaction.count}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChatPanel({ headingFamily, scale = 1 }: { headingFamily: string; scale?: number }): ReactElement {
  return (
    // .previewAccent — terracotta gradient frame filling the cropping wrapper,
    // peeking out on the card's top + left, carrying the white diagonal texture.
    // Explicit width/height (satori resolves these reliably; inset is flaky).
    // Top-left corner is rounded; right + bottom run flush to the canvas corner.
    <div
      style={{
        display: 'flex',
        position: 'absolute',
        left: 0,
        top: 0,
        width: 660 * scale,
        height: 600 * scale,
        borderTopLeftRadius: 24 * scale,
        overflow: 'hidden',
        background: `linear-gradient(135deg, ${PALETTE.terracotta} 0%, ${PALETTE.terracottaDeep} 100%)`,
      }}
    >
      {/* .previewAccent::before — faint white diagonal line texture. */}
      <svg
        width={640 * scale}
        height={640 * scale}
        viewBox="0 0 640 640"
        fill="none"
        style={{ position: 'absolute', left: 0, top: 0, display: 'flex' }}
      >
        <g stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round">
          <line x1="-60" y1="150" x2="170" y2="-80" opacity="0.22" />
          <line x1="-60" y1="220" x2="240" y2="-80" opacity="0.18" />
          <line x1="-60" y1="430" x2="120" y2="250" opacity="0.16" />
          <line x1="-40" y1="600" x2="150" y2="410" opacity="0.13" />
        </g>
      </svg>

      {/* .previewChat — dark card anchored flush to the right + bottom edges
          (which bleed off-canvas), inset from the top + left so the orange
          peeks at the card's top-left. Asymmetric radius like the homepage. */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          position: 'absolute',
          top: 22 * scale,
          left: 38 * scale,
          width: 622 * scale,
          height: 578 * scale,
          background: PALETTE.surface,
          border: '2px solid rgba(116, 184, 226, 0.30)',
          borderRadius: `${16 * scale}px 0 0 0`,
          padding: 20 * scale,
          boxShadow: '-16px 16px 44px rgba(0,0,0,0.5)',
          gap: 11 * scale,
        }}
      >
        {/* .chatChannelHeader */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10 * scale,
            paddingBottom: 12 * scale,
            borderBottom: `1px solid ${PALETTE.line}`,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28 * scale,
              height: 28 * scale,
              borderRadius: 8 * scale,
              background: 'rgba(116,184,226,0.22)',
              color: PALETTE.primaryHover,
              fontSize: 17 * scale,
              fontWeight: 700,
            }}
          >
            #
          </div>
          <span
            style={{
              display: 'flex',
              fontFamily: headingFamily,
              fontWeight: 700,
              fontSize: 18 * scale,
              color: PALETTE.fg,
            }}
          >
            proj-pipeline-fix
          </span>
          <span style={{ display: 'flex', marginLeft: 'auto', fontSize: 13 * scale, color: PALETTE.faint }}>
            3 agents
          </span>
        </div>

        {/* Threaded reply at the very top (.chatReply + ::before blue thread line). */}
        <div
          style={{
            display: 'flex',
            position: 'relative',
            marginLeft: 12 * scale,
            paddingLeft: 14 * scale,
          }}
        >
          <div
            style={{
              display: 'flex',
              position: 'absolute',
              left: 0,
              top: 2 * scale,
              bottom: 2 * scale,
              width: 2 * scale,
              borderRadius: 2 * scale,
              background: PALETTE.primary,
              opacity: 0.6,
            }}
          />
          <span style={{ display: 'flex', fontSize: 13 * scale, color: PALETTE.muted, lineHeight: 1.4 }}>
            Already added the GitHub Actions fixture.
          </span>
        </div>

        {/* Message cards */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 * scale }}>
          {LANDING_MESSAGES.map((m, i) => (
            <ChatMessageCard key={i} message={m} scale={scale} />
          ))}
        </div>

        {/* .chatInput composer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            marginTop: 2 * scale,
            padding: `${10 * scale}px ${14 * scale}px`,
            borderRadius: 10 * scale,
            background: 'rgba(8,17,26,0.7)',
            border: `1px solid ${PALETTE.line}`,
          }}
        >
          <span style={{ display: 'flex', fontSize: 13 * scale, color: PALETTE.faint, flex: 1 }}>
            Send a message…
          </span>
          <div
            style={{
              display: 'flex',
              width: 2 * scale,
              height: 16 * scale,
              background: PALETTE.primary,
              opacity: 0.8,
              borderRadius: 2 * scale,
            }}
          />
        </div>
      </div>
    </div>
  );
}

export function LandingVariant({
  headingFamily,
  bodyFamily,
}: {
  headingFamily: string;
  bodyFamily: string;
}): ReactElement {
  return (
    <Frame bodyFamily={bodyFamily}>
      <SwoopLines top={420} opacity={0.18} />

      {/* LEFT ~55%: copy */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          width: 600,
          flexShrink: 0,
          padding: '0 0 0 80px',
          position: 'relative',
        }}
      >
        <div style={{ display: 'flex', marginBottom: 44 }}>
          <BrandLockup scale={1.4} />
        </div>
        {/* Main-page hero: full white (no blue accent) + heavier Sora 800. */}
        <HeroHeadline headingFamily={headingFamily} fontSize={68} accent={false} fontWeight={800} />
        <div
          style={{
            display: 'flex',
            fontSize: 23,
            lineHeight: 1.5,
            color: PALETTE.muted,
            marginTop: 26,
            maxWidth: 470,
          }}
        >
          Channels, threads, DMs, reactions, and real-time events built for multi-agent systems.
        </div>
      </div>

      {/* RIGHT: chat card pinned into the bottom-right corner. The wrapper is a
          fixed-size cropping box anchored to the canvas's bottom-right with
          negative right/bottom offsets, so the dark card + orange frame bleed
          off the right + bottom edges; the Frame root clips the overflow. The
          top-left corner stays on-canvas, where the orange peeks. */}
      <div
        style={{
          display: 'flex',
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 594,
          height: 540,
          overflow: 'hidden',
        }}
      >
        <ChatPanel headingFamily={headingFamily} scale={0.9} />
      </div>
    </Frame>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Pear mark — the ripe-pear glyph from app/pear/page.tsx (green body + brown
// stem), inlined for satori. Used by the Pear OG card's lockup.
// ───────────────────────────────────────────────────────────────────────────

const PEAR_BODY_PATH =
  'M7.681 9.097c1.587-3.151 7.698-1.916 11.958 2.171 2.697 2.586 8.056 1.498 11.498 4.804 3.493 3.354 3.259 9.361-3.053 15.767C23 37 16 37 11.835 33.384c-4.388-3.811-2.476-8.61-4.412-13.585S3.1 9.375 7.681 9.097Z';
const PEAR_STEM_PATH =
  'M8.178 9.534c-.43.448-1.114.489-1.527.093-3.208-3.079-3.918-7.544-3.946-7.776-.074-.586.348-1.157.939-1.278.592-.121 1.131.257 1.205.842.006.05.657 3.997 3.359 6.59.413.397.4 1.081-.03 1.529Z';

const PEAR_GREEN = '#A6D388';

function PearMark({ size = 46 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'flex' }}
    >
      <path fill={PEAR_GREEN} d={PEAR_BODY_PATH} />
      <path fill="#662113" d={PEAR_STEM_PATH} />
    </svg>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Variant: PEAR — left copy column + the Pear desktop-app screenshot pinned
// into the bottom-right corner.
//
// Reuses the LandingVariant composition (left ~50% copy, a graphic bled off the
// right + bottom edges with the terracotta accent peeking at its top-left) but
// swaps the synthetic chat panel for the real product screenshot
// (public/img/pear-app.png), zoomed in on its top-left so the #general channel
// reads clearly and the rest of the window runs off the bottom-right of the card.
//
// `screenshot` is a data URL (the PNG read + base64-encoded by the route). When
// it is absent (e.g. the file could not be read at build) the panel still
// renders its frame so the card never breaks.
// ───────────────────────────────────────────────────────────────────────────

function PearShot({ screenshot, scale = 1 }: { screenshot?: string; scale?: number }): ReactElement {
  return (
    // Terracotta accent frame filling the cropping wrapper, peeking out on the
    // window's top + left, carrying the faint white diagonal texture. Top-left
    // corner is rounded; right + bottom run flush to the canvas corner.
    <div
      style={{
        display: 'flex',
        position: 'absolute',
        left: 0,
        top: 0,
        width: 660 * scale,
        height: 600 * scale,
        borderTopLeftRadius: 24 * scale,
        overflow: 'hidden',
        background: `linear-gradient(135deg, ${PALETTE.terracotta} 0%, ${PALETTE.terracottaDeep} 100%)`,
      }}
    >
      <svg
        width={640 * scale}
        height={640 * scale}
        viewBox="0 0 640 640"
        fill="none"
        style={{ position: 'absolute', left: 0, top: 0, display: 'flex' }}
      >
        <g stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round">
          <line x1="-60" y1="150" x2="170" y2="-80" opacity="0.22" />
          <line x1="-60" y1="220" x2="240" y2="-80" opacity="0.18" />
          <line x1="-60" y1="430" x2="120" y2="250" opacity="0.16" />
          <line x1="-40" y1="600" x2="150" y2="410" opacity="0.13" />
        </g>
      </svg>

      {/* The window: a dark card anchored flush to the right + bottom edges
          (which bleed off-canvas), inset from the top + left so the orange peeks
          at its top-left. Asymmetric radius like the homepage chat preview. The
          screenshot is anchored to the card's top-left and rendered larger than
          the card, so only its zoomed top-left shows; the rest is clipped. */}
      <div
        style={{
          display: 'flex',
          position: 'absolute',
          top: 22 * scale,
          left: 38 * scale,
          width: 622 * scale,
          height: 578 * scale,
          background: PALETTE.surface,
          border: '2px solid rgba(116, 184, 226, 0.30)',
          borderRadius: `${16 * scale}px 0 0 0`,
          overflow: 'hidden',
          boxShadow: '-16px 16px 44px rgba(0,0,0,0.5)',
        }}
      >
        {screenshot ? (
          // satori renders raster images directly; next/image is not usable here.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={screenshot}
            alt="Pear desktop app"
            width={1112 * scale}
            height={828 * scale}
            style={{ position: 'absolute', left: 0, top: 0, display: 'flex' }}
          />
        ) : null}
      </div>
    </div>
  );
}

export function PearVariant({
  headingFamily,
  bodyFamily,
  screenshot,
}: {
  headingFamily: string;
  bodyFamily: string;
  screenshot?: string;
}): ReactElement {
  return (
    <Frame bodyFamily={bodyFamily}>
      <SwoopLines top={420} opacity={0.18} />

      {/* LEFT: copy */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          width: 600,
          flexShrink: 0,
          padding: '0 0 0 80px',
          position: 'relative',
        }}
      >
        {/* Lockup: pear mark + "Pear" wordmark + a muted "by Agent Relay". */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 40 }}>
          <PearMark size={48} />
          <span
            style={{
              display: 'flex',
              fontFamily: headingFamily,
              fontWeight: 800,
              fontSize: 42,
              letterSpacing: '-0.03em',
              color: PALETTE.fg,
            }}
          >
            Pear
          </span>
          <span style={{ display: 'flex', fontSize: 18, color: PALETTE.faint, marginTop: 14 }}>
            by Agent Relay
          </span>
        </div>

        {/* Hero headline, heavier Sora 800 with "team" in pear green. */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            fontFamily: headingFamily,
            fontWeight: 800,
            fontSize: 58,
            lineHeight: 1.0,
            letterSpacing: '-0.04em',
            color: PALETTE.fg,
          }}
        >
          <span style={{ display: 'flex', fontWeight: 800 }}>Pair program</span>
          <span style={{ display: 'flex', flexWrap: 'wrap', fontWeight: 800 }}>
            <span style={{ display: 'flex', fontWeight: 800 }}>with a&nbsp;</span>
            <span style={{ display: 'flex', fontWeight: 800, color: PEAR_GREEN }}>team</span>
            <span style={{ display: 'flex', fontWeight: 800 }}>&nbsp;of agents</span>
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            fontSize: 22,
            lineHeight: 1.5,
            color: PALETTE.muted,
            marginTop: 24,
            maxWidth: 480,
          }}
        >
          A desktop workspace where AI coding agents run in their own terminals, talk to each other, and
          bring every diff back to you.
        </div>
      </div>

      {/* RIGHT: the product screenshot pinned into the bottom-right corner. Same
          cropping-box trick as the landing chat card: a fixed box anchored to the
          canvas bottom-right so the window bleeds off the right + bottom edges,
          with the terracotta accent peeking at the on-canvas top-left corner. */}
      <div
        style={{
          display: 'flex',
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 594,
          height: 540,
          overflow: 'hidden',
        }}
      >
        <PearShot screenshot={screenshot} scale={0.9} />
      </div>
    </Frame>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Variant: BLOG — logo + wordmark, big title, author/date/meta footer.
// ───────────────────────────────────────────────────────────────────────────

export function BlogVariant({
  headingFamily,
  bodyFamily,
  title,
  author,
  date,
  meta,
  category,
}: {
  headingFamily: string;
  bodyFamily: string;
  title: string;
  author: string;
  /** Pre-formatted publish date string. */
  date?: string;
  /** Reading time or similar secondary meta. */
  meta?: string;
  category?: string;
}): ReactElement {
  const authorInitial = author ? author[0].toUpperCase() : 'A';
  const footerBits = [date, meta].filter(Boolean) as string[];

  return (
    <Frame bodyFamily={bodyFamily}>
      <SwoopLines top={430} opacity={0.22} />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: '100%',
          height: '100%',
          padding: '64px 80px',
          position: 'relative',
        }}
      >
        {/* Top: lockup + optional category */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <BrandLockup scale={1.4} />
          {category ? (
            <div
              style={{
                display: 'flex',
                padding: '7px 15px',
                borderRadius: 999,
                background: 'rgba(116,184,226,0.12)',
                border: `1px solid ${PALETTE.line}`,
                color: PALETTE.primaryHover,
                fontSize: 16,
                fontWeight: 500,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
              }}
            >
              {category}
            </div>
          ) : null}
        </div>

        {/* Middle: title */}
        <div
          style={{
            display: 'flex',
            fontFamily: headingFamily,
            fontWeight: 700,
            fontSize: 62,
            lineHeight: 1.06,
            letterSpacing: '-0.04em',
            color: PALETTE.fg,
            maxWidth: 1040,
            // satori clamps with these in flex context; keep it readable to ~3 lines.
          }}
        >
          {title}
        </div>

        {/* Bottom: author + meta */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 50,
              height: 50,
              borderRadius: 12,
              background: 'linear-gradient(145deg, #74B8E2 0%, #3B789F 100%)',
              color: PALETTE.bg,
              fontSize: 22,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {authorInitial}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {author ? (
              <span style={{ display: 'flex', fontSize: 22, fontWeight: 500, color: PALETTE.fg }}>
                {author}
              </span>
            ) : null}
            {footerBits.length ? (
              <span style={{ display: 'flex', fontSize: 18, color: PALETTE.faint }}>
                {footerBits.join('  ·  ')}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </Frame>
  );
}
