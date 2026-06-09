'use client';

import { Fragment, useState } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';

import { FadeIn } from '../FadeIn';
import s from '../../app/agents/agents.module.css';

const BUILD_AGENT_PROMPT = `Build me a new AgentWorkforce agent and prepare it to deploy on Agent Relay.

Use the AgentWorkforce agents repo (https://github.com/AgentWorkforce/agents) as the structural reference, and the "creating-cloud-persona" skill for how to structure it.

The agent should: <describe the job in one or two sentences — e.g. "every weekday morning, check our GitHub releases and post a summary to our #eng Slack channel">.

Steps:
1. Read an existing agent in the repo (e.g. review/ or vendor-monitor/) to learn the persona.json + agent.ts shape.
2. Scaffold a new <slug>/ folder:
   - persona.json: id, intent, tags, description, cloud: true, the integrations the job needs (scoped paths only), harness/model, and the inputs a user must configure.
   - agent.ts: declare the trigger or cron schedule with defineAgent(...) and implement the behavior, branching on event.source/event.type.
3. Wire only the integrations the job actually uses, and expose each user-configurable value as an input with a picker where one applies.
4. Keep it minimal, match the repo's patterns, typecheck/build, and tell me exactly how to deploy it on Agent Relay.`;

const PREVIEW = `${BUILD_AGENT_PROMPT.replace(/\s+/g, ' ').slice(0, 96)}...`;

const INSTALL_CMDS = [
  'npx skills add https://github.com/agentworkforce/skills --skill creating-cloud-persona',
  'npx prpm install @agent-relay/creating-cloud-persona --as codex,claude',
];

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for embedded browsers that expose clipboard without write access.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

export function BuildYourOwn() {
  const [copied, setCopied] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  async function handleCopy() {
    await copyText(BUILD_AGENT_PROMPT);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function handleCopyCmd(cmd: string) {
    await copyText(cmd);
    setCopiedCmd(cmd);
    window.setTimeout(() => setCopiedCmd(null), 1800);
  }

  return (
    <div className={s.buildWrapper}>
      <section className={s.buildSection}>
        <FadeIn direction="up">
          <div className={s.buildHeader}>
            <div className={s.badge}>
              <span className={s.badgeDot} />
              BUILD YOUR OWN
            </div>
            <h2 className={s.buildTitle}>Can&apos;t find the one you need? Build it.</h2>
            <p className={s.buildSubtitle}>
              An agent is just a <code>persona.json</code> and an <code>agent.ts</code> handler. Paste this
              prompt into your coding agent — it reads the open-source examples, follows the persona skills,
              and scaffolds a deployable agent for you.
            </p>
          </div>
        </FadeIn>

        <FadeIn direction="up" delay={80}>
          <div className={s.buildStep}>
            <span className={s.buildStepLabel}>1 · Download the persona skill</span>
            {INSTALL_CMDS.map((cmd, i) => (
              <Fragment key={cmd}>
                {i > 0 && <span className={s.installOr}>or</span>}
                <div className={s.installCmd}>
                  <code className={s.installCmdText}>{cmd}</code>
                  <button
                    className={s.installCmdCopy}
                    type="button"
                    onClick={() => handleCopyCmd(cmd)}
                    aria-label="Copy install command"
                  >
                    {copiedCmd === cmd ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  </button>
                </div>
              </Fragment>
            ))}
          </div>
        </FadeIn>

        <FadeIn direction="up" delay={140}>
          <span className={s.buildStepLabel}>2 · Paste this prompt into your coding agent</span>
          <div className={s.promptCard} data-prompt-open={showPrompt}>
            <span className={s.promptPreview}>{PREVIEW}</span>

            {showPrompt && (
              <div className={s.promptPanel} id="build-agent-prompt">
                <span className={s.promptPanelTitle}>Prompt</span>
                <span className={s.promptPanelBody}>{BUILD_AGENT_PROMPT}</span>
              </div>
            )}

            <div className={s.promptActions}>
              <button
                className={s.promptShow}
                type="button"
                aria-controls="build-agent-prompt"
                aria-expanded={showPrompt}
                onClick={() => setShowPrompt((value) => !value)}
              >
                {showPrompt ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                {showPrompt ? 'Hide prompt' : 'Show prompt'}
              </button>
              <button
                className={s.promptCta}
                type="button"
                onClick={handleCopy}
                aria-label="Copy the build-your-own-agent prompt"
              >
                {copied ? (
                  <>
                    <Check aria-hidden="true" /> Copied
                  </>
                ) : (
                  <>
                    <Copy aria-hidden="true" /> Copy prompt
                  </>
                )}
              </button>
            </div>
          </div>
        </FadeIn>

        <FadeIn direction="up" delay={200}>
          <div className={s.buildLinks}>
            <a
              href="https://github.com/AgentWorkforce/agents"
              target="_blank"
              rel="noopener noreferrer"
              className={s.pill}
            >
              Browse the examples
            </a>
            <a
              href="https://github.com/AgentWorkforce/skills/blob/main/skills/creating-cloud-persona/SKILL.md"
              target="_blank"
              rel="noopener noreferrer"
              className={s.pill}
            >
              Read the persona skill
            </a>
          </div>
        </FadeIn>
      </section>
    </div>
  );
}
