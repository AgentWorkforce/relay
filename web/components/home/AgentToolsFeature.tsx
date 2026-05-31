import MCP from '@lobehub/icons/es/MCP';
import { SquareTerminal } from 'lucide-react';

import { FadeIn } from '../FadeIn';
import s from '../../app/landing.module.css';

/** Syntax-highlight kinds mapped to the editor's CSS module classes. */
type TokenKind = 'muted' | 'fn' | 'var' | 'kw' | 'str';

const TOKEN_CLASS: Record<TokenKind, string> = {
  muted: s.codeMuted,
  fn: s.codeFunction,
  var: s.codeVariable,
  kw: s.codeKeyword,
  str: s.codeString,
};

/**
 * The orchestrator.ts snippet, expressed as ordered tokens. Plain segments
 * (including whitespace/newlines) carry no kind; highlighted segments name the
 * span color. Rendered into a `pre` whose `white-space: pre-wrap` preserves the
 * literal spacing here.
 */
const EDITOR_TOKENS: ReadonlyArray<{ text: string; kind?: TokenKind }> = [
  { text: '// Define callbacks from agent actions ', kind: 'muted' },
  { text: '\nrelay.' },
  { text: 'on', kind: 'fn' },
  { text: '(\n engineer.' },
  { text: 'status', kind: 'var' },
  { text: '.' },
  { text: 'becomes', kind: 'fn' },
  { text: '(' },
  { text: '"idle"', kind: 'str' },
  { text: '),\n ' },
  { text: 'async', kind: 'kw' },
  { text: ' () =>\n relay.' },
  { text: 'sendMessage', kind: 'fn' },
  { text: '({\n to: taskManager,\n msg: ' },
  { text: '`${engineer.handle} is idle. Send the next task.`', kind: 'str' },
  { text: ',\n }),\n);' },
];

export function AgentToolsFeature() {
  return (
    <FadeIn direction="up" delay={180} className={`${s.featureCol} ${s.commandsFeature}`}>
      <div className={s.featureCopy}>
        <h3 className={s.featureTitle}>Agent Tools for Structured Work</h3>
        <ul className={s.featureList}>
          <li>Register actions for agents and callbacks for results via the SDK</li>
          <li>Expose CLI and MCP tools so agents can communicate progress back to the SDK.</li>
          <li>
            Require approvals, validate inputs, and return structured results instead of free-form guesses.
          </li>
          <li>Keep action updates attached to the right channel, thread, and workflow state.</li>
        </ul>
        <div className={s.actionToolBadges} aria-label="Agent Relay tool surfaces">
          <span className={s.actionToolBadge} tabIndex={0} aria-label="Agent Relay MCP">
            <MCP size={20} aria-hidden="true" />
            <span className={s.actionToolTooltip} role="tooltip">
              <strong>MCP</strong>
              The Agent Relay MCP exposes tool calls you define via the SDK that you can define callbacks for.
            </span>
          </span>
          <span className={s.actionToolBadge} tabIndex={0} aria-label="Agent Relay CLI">
            <SquareTerminal size={20} strokeWidth={1.8} aria-hidden="true" />
            <span className={s.actionToolTooltip} role="tooltip">
              <strong>CLI</strong>
              The Agent Relay CLI exposes actions you define via the SDK as terminal commands the agent can
              use and you can define callbacks for.
            </span>
          </span>
        </div>
      </div>
      <div className={`${s.featurePreview} ${s.commandsEditorPreview}`}>
        <div className={s.editorWindow}>
          <div className={s.editorTitlebar}>
            <span />
            <span />
            <span />
            <strong>orchestrator.ts</strong>
          </div>
          <pre className={s.editorCode}>
            <code>
              {EDITOR_TOKENS.map(({ text, kind }, i) =>
                kind ? (
                  <span key={i} className={TOKEN_CLASS[kind]}>
                    {text}
                  </span>
                ) : (
                  <span key={i}>{text}</span>
                )
              )}
            </code>
          </pre>
        </div>
      </div>
    </FadeIn>
  );
}
