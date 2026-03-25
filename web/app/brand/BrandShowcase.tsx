'use client';

import type { CSSProperties } from 'react';
import { Home, Search, Shapes, Tag, Trash2, User, Wand2 } from 'lucide-react';

import { LogoIcon, LogoWordmark } from '../../components/SiteNav';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import s from './brand.module.css';

type ThemeToken = {
  name: string;
  value: string;
  use: string;
};

type HeroPaletteCard = {
  label: string;
  value: string;
  textLight?: boolean;
  scale?: string[];
};

const THEME_TOKENS: ThemeToken[] = [
  { name: 'bg', value: '#F9FAFB', use: 'Page background' },
  { name: 'fg', value: '#111827', use: 'Main text' },
  { name: 'fg-muted', value: '#4B5563', use: 'Secondary text' },
  { name: 'primary', value: '#4A90C2', use: 'Primary brand color (500)' },
  { name: 'primary-hover', value: '#2D6A9C', use: 'Button hover (600)' },
  { name: 'primary-ink', value: '#234969', use: 'Deep blue text accent (800)' },
  { name: 'secondary', value: '#C1674B', use: 'Secondary brand color (500)' },
  { name: 'surface', value: '#F3F4F6', use: 'Panels and code blocks' },
  { name: 'card-bg', value: 'rgba(255, 255, 255, 0.90)', use: 'Raised cards' },
];

const HERO_PALETTE: HeroPaletteCard[] = [
  {
    label: 'Primary',
    value: '#4A90C2',
    textLight: true,
    scale: [
      '#F3F7FC', '#E7EFF7', '#C9DDEE', '#99C2E0', '#62A1CE',
      '#4A90C2', '#2D6A9C', '#26557E', '#234969', '#223E58', '#16283B',
    ],
  },
  {
    label: 'Secondary',
    value: '#C1674B',
    textLight: true,
    scale: [
      '#FBF5F1', '#F5E8DF', '#EACEBE', '#DCAD95', '#CD866A',
      '#C1674B', '#B45542', '#964338', '#793833', '#62302C', '#341716',
    ],
  },
  { label: 'Surface', value: '#F3F4F6' },
  {
    label: 'Neutral',
    value: '#a5836a',
    textLight: true,
    scale: [
      '#f5f2ee', '#efebe5', '#dfd5c9', '#cab9a7', '#b49a83',
      '#a5836a', '#98735e', '#7f5e4f', '#684e44', '#554139', '#2d211d',
    ],
  },
];

const BRAND_ACCENTS = [
  { name: 'Logo primary', value: '#4A90C2', use: 'Primary icon mark' },
  { name: 'Logo secondary', value: 'rgba(74, 144, 194, 0.5)', use: 'Trailing icon facet' },
  { name: 'Warm accent', value: '#C1674B', use: 'Secondary brand color (500)' },
  { name: 'Warm accent deep', value: '#B45542', use: 'Secondary hover (600)' },
  { name: 'Warm accent soft', value: '#CD866A', use: 'Secondary highlight (400)' },
  { name: 'Status red', value: '#FF5F57', use: 'Terminal chrome' },
  { name: 'Status yellow', value: '#FEBC2E', use: 'Terminal chrome' },
  { name: 'Status green', value: '#28C840', use: 'Terminal chrome' },
];

function buildSnippet(tokens: ThemeToken[]) {
  const lines = tokens.map((token) => `  --${token.name}: ${token.value};`);
  return [':root {', ...lines, '}'].join('\n');
}

function brandButtonClass(variant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive') {
  if (variant === 'default' || variant === undefined) {
    return s.brandCtaPrimary;
  }

  if (variant === 'secondary') {
    return s.brandCtaSecondary;
  }

  return '';
}

export function BrandShowcase() {
  const snippet = buildSnippet(THEME_TOKENS);
  return (
    <main className={s.page}>
      <section className={s.hero}>
        <div className={s.heroIntro}>
          <div>
            <p className={s.eyebrow}>Brand System</p>
            <h1 className={s.title}>Brand &amp; color system</h1>
            <p className={s.lead}>
              Palette, type scale, controls, and logo treatment.
            </p>
          </div>
          <div className={s.heroFacts}>
            <Badge className={s.factPill}>Agent Relay</Badge>
            <a href="/brand.css" className={s.pathPill}>/brand.css</a>
          </div>
        </div>

        <div className={s.heroBoard}>
          <div className={s.heroPaletteColumn}>
            {HERO_PALETTE.map((card) => (
              <Card key={card.label} className={s.paletteCard}>
                <div
                  className={`${s.paletteTop} ${card.textLight ? s.paletteTopLight : ''}`}
                  style={{ background: card.value }}
                >
                  <span>{card.label}</span>
                  <code>{card.value}</code>
                </div>
                {card.scale ? (
                  <div className={s.paletteScaleExplicit}>
                    {card.scale.map((hex) => (
                      <span key={hex} style={{ background: hex }} />
                    ))}
                  </div>
                ) : (
                  <div className={s.paletteScale} style={{ '--tone': card.value } as CSSProperties}>
                    {Array.from({ length: 8 }).map((_, index) => (
                      <span key={index} />
                    ))}
                  </div>
                )}
              </Card>
            ))}
          </div>

          <Card className={`${s.heroCard} ${s.typeCard}`}>
            <div>
              <p className={s.heroCardLabel}>Headline</p>
              <div className={s.typeSpecimen}>Aa</div>
            </div>
            <div>
              <p className={s.heroCardLabel}>Body</p>
              <div className={s.bodySpecimen}>Spawn, coordinate, and connect AI agents in real-time from TypeScript or Python.</div>
            </div>
          </Card>

          <Card className={s.heroCard}>
            <div className={s.buttonMatrix}>
              <Button type="button" className={`w-full ${s.brandCtaPrimary}`}>Primary</Button>
              <Button type="button" variant="secondary" className={`w-full ${s.brandCtaSecondary}`}>Secondary</Button>
              <Button type="button" variant="outline" className="w-full">Outline</Button>
              <Button type="button" variant="ghost" className="w-full">Ghost</Button>
              <Button type="button" variant="destructive" className="w-full">Destructive</Button>
            </div>
          </Card>

          <Card className={s.heroCard}>
            <div className={s.searchField}>
              <Search />
              <Input placeholder="Search agents, docs..." readOnly aria-label="Search example" />
            </div>
          </Card>

          <Card className={s.heroCard}>
            <div className={s.rhythmLines}>
              <span className={s.rhythmLinePrimary} />
              <span className={s.rhythmLineSecondary} />
              <span className={s.rhythmLineTertiary} />
            </div>
          </Card>

          <Card className={s.heroCard}>
            <div className={s.navPill}>
              <Button variant="secondary" size="icon" className={s.navPillActive}><Home /></Button>
              <Button variant="ghost" size="icon" className={s.navPillIcon}><Search /></Button>
              <Button variant="ghost" size="icon" className={s.navPillIcon}><User /></Button>
            </div>
          </Card>

          <Card className={s.heroCard}>
            <div className={s.iconRow}>
              <Button variant="ghost" size="icon" className={s.iconChip}><Wand2 /></Button>
              <Button variant="ghost" size="icon" className={s.iconChip}><Shapes /></Button>
              <Button variant="ghost" size="icon" className={s.iconChip}><Tag /></Button>
              <Button variant="ghost" size="icon" className={s.iconChipDanger}><Trash2 /></Button>
            </div>
          </Card>
        </div>
      </section>

      <section className={s.section}>
        <div className={s.logoPreviewSection}>
          <article className={s.logoPreviewCard}>
            <div className={s.logoPreviewSurface}>
              <div className={s.logoPreviewLockup}>
                <LogoIcon />
                <LogoWordmark />
              </div>
            </div>
            <div className={s.logoPreviewMeta}>
              <div>
                <p className={s.tokenName}>Primary-color logo</p>
                <p className={s.tokenUse}>
                  The logo mark and wordmark rendered in the theme primary.
                </p>
              </div>
              <code className={s.tokenValue}>
                {THEME_TOKENS.find((token) => token.name === 'primary')?.value}
              </code>
            </div>
          </article>
        </div>
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}>
          <div>
            <p className={s.sectionEyebrow}>Theme</p>
            <h2 className={s.sectionTitle}>Agent Relay</h2>
            <p className={s.sectionText}>The default public brand: airy blue, crisp ink, clean UI.</p>
          </div>
        </div>

        <div className={s.tokenGrid}>
          {THEME_TOKENS.map((token) => (
            <article key={token.name} className={s.tokenCard}>
              <div className={s.tokenSwatch} style={{ background: token.value }} />
              <div className={s.tokenMeta}>
                <div>
                  <p className={s.tokenName}>{token.name}</p>
                  <p className={s.tokenUse}>{token.use}</p>
                </div>
                <code className={s.tokenValue}>{token.value}</code>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}>
          <div>
            <p className={s.sectionEyebrow}>Shared Accents</p>
            <h2 className={s.sectionTitle}>Brand-supporting colors</h2>
            <p className={s.sectionText}>
              These show up in the logo, illustrations, terminal chrome, and
              product demo surfaces.
            </p>
          </div>
        </div>

        <div className={s.accentGrid}>
          {BRAND_ACCENTS.map((accent) => (
            <article key={accent.name} className={s.accentCard}>
              <span className={s.accentChip} style={{ background: accent.value }} />
              <div>
                <p className={s.tokenName}>{accent.name}</p>
                <p className={s.tokenUse}>{accent.use}</p>
                <code className={s.tokenValue}>{accent.value}</code>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}>
          <div>
            <p className={s.sectionEyebrow}>UI Primitives</p>
            <h2 className={s.sectionTitle}>shadcn component examples</h2>
            <p className={s.sectionText}>
              The palette page now uses these primitives directly instead of
              hand-rolled controls.
            </p>
          </div>
        </div>

        <div className={s.buttonShowcase}>
          {([
            { variant: 'default', label: 'Primary' },
            { variant: 'secondary', label: 'Secondary' },
            { variant: 'ghost', label: 'Ghost' },
            { variant: 'destructive', label: 'Destructive' },
          ] as const).map(({ variant, label }) => (
            <Card key={variant} className={s.buttonVariantCard}>
              <p className={s.buttonVariantLabel}>{label}</p>
              <div className={s.buttonStateGrid}>
                <div className={s.buttonStateCol}>
                  <Button type="button" variant={variant} className={`w-full ${brandButtonClass(variant)}`}>
                    {label}
                  </Button>
                  <span className={s.buttonStateLabel}>Default</span>
                </div>
                <div className={s.buttonStateCol}>
                  <Button
                    type="button"
                    variant={variant}
                    className={`w-full ${brandButtonClass(variant)}`}
                    data-state="hover"
                  >
                    {label}
                  </Button>
                  <span className={s.buttonStateLabel}>Hover</span>
                </div>
                <div className={s.buttonStateCol}>
                  <Button
                    type="button"
                    variant={variant}
                    className={`w-full ${brandButtonClass(variant)}`}
                    data-state="active"
                  >
                    {label}
                  </Button>
                  <span className={s.buttonStateLabel}>Active</span>
                </div>
                <div className={s.buttonStateCol}>
                  <Button type="button" variant={variant} className={`w-full ${brandButtonClass(variant)}`} disabled>
                    {label}
                  </Button>
                  <span className={s.buttonStateLabel}>Disabled</span>
                </div>
              </div>
            </Card>
          ))}
        </div>

        <div className={s.previewGrid} style={{ marginTop: 12 }}>
          <Card className={s.previewCard}>
            <CardHeader className="p-0 pb-4">
              <CardTitle className="text-[1.05rem]">Badges</CardTitle>
              <CardDescription>Status and label variants.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className={s.badgeRow}>
                <Badge>Active</Badge>
                <Badge variant="secondary">Secondary</Badge>
                <Badge variant="outline">Outline</Badge>
              </div>
            </CardContent>
          </Card>

          <Card className={s.previewCard}>
            <CardHeader className="p-0 pb-4">
              <CardTitle className="text-[1.05rem]">Input and card</CardTitle>
              <CardDescription>Search field and a standard shadcn card shell.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className={s.inputPreview}>
                <Search className={s.inputPreviewIcon} />
                <Input placeholder="Search agents, docs, or channels" />
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}>
          <div>
            <p className={s.sectionEyebrow}>Component Preview</p>
            <h2 className={s.sectionTitle}>Common UI surfaces</h2>
            <p className={s.sectionText}>
              This is the fastest way to judge whether the theme feels usable,
              not just attractive.
            </p>
          </div>
        </div>

        <div className={s.previewGrid}>
          <Card className={s.previewCard}>
            <div className={s.previewTop}>
              <Badge>Relay Ready</Badge>
              <Badge variant="secondary">Live Preview</Badge>
            </div>
            <h3 className={s.previewTitle}>Primary actions</h3>
            <p className={s.previewText}>
              Buttons, tags, and neutral containers using the semantic palette.
            </p>
            <div className={s.buttonRow}>
              <Button size={'lg'} type="button" className={s.brandCtaPrimary}>Read the Docs</Button>
              <Button size={'lg'} type="button" variant="secondary" className={s.brandCtaSecondary}>Open GitHub</Button>
            </div>
          </Card>

          <Card className={s.previewCard}>
            <div className={s.statRow}>
              <div>
                <p className={s.statLabel}>Observer Sessions</p>
                <p className={s.statValue}>12,543</p>
              </div>
              <div className={s.statusDot} />
            </div>
            <div className={s.chart}>
              <span style={{ height: '52%' }} />
              <span style={{ height: '76%' }} />
              <span style={{ height: '34%' }} />
              <span style={{ height: '68%' }} />
              <span style={{ height: '44%' }} />
              <span style={{ height: '86%' }} />
            </div>
            <p className={s.chartCaption}>Muted data colors derive from the theme palette.</p>
          </Card>

          <Card className={s.previewCard}>
            <div className={s.messageList}>
              <div className={s.messageBubble}>
                <p className={s.messageAuthor}>Planner</p>
                <p className={s.messageBody}>Split the rollout into API, UI, and review lanes.</p>
              </div>
              <div className={s.messageBubble}>
                <p className={s.messageAuthor}>Builder</p>
                <p className={s.messageBody}>Theme tokens are wired. Shipping the palette page next.</p>
              </div>
              <div className={s.inputShell}>Message #brand-review</div>
            </div>
          </Card>

          <Card className={`${s.previewCard} ${s.codeCard}`}>
            <div className={s.terminalBar}>
              <span className={s.dotRed} />
              <span className={s.dotYellow} />
              <span className={s.dotGreen} />
            </div>
            <pre className={s.codeBlock}>
              <span className="syn-comment">{'// semantic token example'}</span>{'\n'}
              <span className="syn-keyword">const</span>{' palette = {'}{'\n'}
              {'  '}<span className="syn-type">primary</span>{': '}<span className="syn-string">{`'${THEME_TOKENS.find((t) => t.name === 'primary')?.value}'`}</span>{','}{'\n'}
              {'  '}<span className="syn-type">surface</span>{': '}<span className="syn-string">{`'${THEME_TOKENS.find((t) => t.name === 'surface')?.value}'`}</span>{','}{'\n'}
              {'};'}{'\n'}
              <span className="syn-keyword">export</span>{' '}<span className="syn-keyword">default</span>{' palette;'}
            </pre>
          </Card>
        </div>
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}>
          <div>
            <p className={s.sectionEyebrow}>Copy/Paste</p>
            <h2 className={s.sectionTitle}>Theme snippet</h2>
            <p className={s.sectionText}>
              Compact version of the theme tokens for quick copy-paste into
              another project.
            </p>
          </div>
        </div>

        <pre className={s.snippet}>{snippet}</pre>
      </section>

    </main>
  );
}
