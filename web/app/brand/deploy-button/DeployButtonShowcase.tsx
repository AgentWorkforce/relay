import Link from 'next/link';

import s from './styles.module.css';

type Variant = {
  id: string;
  file: string;
  title: string;
  note: string;
};

const HOST = 'https://agentrelay.net';

const VARIANTS: Variant[] = [
  {
    id: 'launch',
    file: 'launch-agent.svg',
    title: 'Launch Agent → (primary)',
    note: 'Full brand lockup with CTA. The canonical button: mark + wordmark + divider + "Launch Agent →" on the baby-blue gradient.',
  },
  {
    id: 'launch-small',
    file: 'launch-agent_small.svg',
    title: 'Launch Agent → (small)',
    note: 'Compact 32px-tall version with just the logomark and CTA — no wordmark. Use in tight spaces, inline next to other badges, or wherever the full brand wordmark would be too heavy.',
  },
];

function snippet(file: string): string {
  const url = `${HOST}/${file}`;
  return `[![Launch Agent](${url})](${HOST}/launch?repo=…)`;
}

export function DeployButtonShowcase() {
  return (
    <main className={s.page}>
      <section className={`${s.section} ${s.hero}`}>
        <p className={s.eyebrow}>Brand · Launch Agent Button</p>
        <h1 className={s.title}>Launch Agent button</h1>
        <p className={s.lead}>
          Embedded by users in their own README files to launch an agent from a repo. Two locked-in
          variants — full and compact — hosted as SVG at <code>{HOST}/launch-agent.svg</code> and
          <code> {HOST}/launch-agent_small.svg</code>. SVG renders natively on GitHub; PNG fallbacks
          can be exported if needed for surfaces that strip SVG.
        </p>
      </section>

      <section className={s.section}>
        <div className={s.variantGrid}>
          {VARIANTS.map((v) => (
            <article key={v.id} className={s.variantCard}>
              <header className={s.variantHeader}>
                <div>
                  <div className={s.variantTitle}>{v.title}</div>
                  <p className={s.variantNote}>{v.note}</p>
                </div>
                <code className={s.variantId}>{v.file}</code>
              </header>

              <div className={s.stage}>
                <div className={s.stageCellWrap}>
                  <div className={`${s.stageCell} ${s.stageLight}`}>
                    <img src={`/${v.file}`} alt={`${v.title} on light`} />
                  </div>
                  <span className={s.stageLabel}>Light</span>
                </div>
                <div className={s.stageCellWrap}>
                  <div className={`${s.stageCell} ${s.stageDark}`}>
                    <img src={`/${v.file}`} alt={`${v.title} on dark`} />
                  </div>
                  <span className={s.stageLabel}>Dark</span>
                </div>
              </div>

              <pre className={s.snippet}>{snippet(v.file)}</pre>
            </article>
          ))}
        </div>

        <Link href="/brand" className={s.backLink}>
          ← Back to brand kit
        </Link>
      </section>
    </main>
  );
}
