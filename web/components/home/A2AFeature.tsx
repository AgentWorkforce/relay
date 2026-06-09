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
 * An A2A Agent Card, expressed as ordered tokens. Plain segments (including
 * whitespace/newlines) carry no kind; highlighted segments name the span color.
 * Rendered into a `pre` whose `white-space: pre-wrap` preserves the spacing here.
 */
const AGENT_CARD_TOKENS: ReadonlyArray<{ text: string; kind?: TokenKind }> = [
  { text: '// Any A2A client can discover and call this agent ', kind: 'muted' },
  { text: '\n{\n  ' },
  { text: '"name"', kind: 'var' },
  { text: ': ' },
  { text: '"Scout"', kind: 'str' },
  { text: ',\n  ' },
  { text: '"protocolVersion"', kind: 'var' },
  { text: ': ' },
  { text: '"0.3.0"', kind: 'str' },
  { text: ',\n  ' },
  { text: '"url"', kind: 'var' },
  { text: ': ' },
  { text: '"https://relay.dev/a2a/scout"', kind: 'str' },
  { text: ',\n  ' },
  { text: '"capabilities"', kind: 'var' },
  { text: ': { ' },
  { text: '"streaming"', kind: 'var' },
  { text: ': ' },
  { text: 'true', kind: 'kw' },
  { text: ' },\n  ' },
  { text: '"skills"', kind: 'var' },
  { text: ': [{ ' },
  { text: '"id"', kind: 'var' },
  { text: ': ' },
  { text: '"triage"', kind: 'str' },
  { text: ', ' },
  { text: '"tags"', kind: 'var' },
  { text: ': [' },
  { text: '"routing"', kind: 'str' },
  { text: '] }]\n}' },
];

export function A2AFeature() {
  return (
    <FadeIn direction="up" delay={120} className={`${s.featureCol} ${s.a2aFeature}`}>
      <div className={`${s.featurePreview} ${s.commandsEditorPreview}`}>
        <div className={s.editorWindow}>
          <div className={s.editorTitlebar}>
            <span />
            <span />
            <span />
            <strong>agent-card.json</strong>
          </div>
          <pre className={s.editorCode}>
            <code>
              {AGENT_CARD_TOKENS.map(({ text, kind }, i) =>
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
      <div className={s.featureCopy}>
        <h3 className={s.featureTitle}>Speaks A2A out of the box</h3>
        <ul className={s.featureList}>
          <li>Every Relay agent publishes an A2A Agent Card, so any A2A client can discover and call it.</li>
          <li>Bridge agents built on other frameworks over the open Agent2Agent protocol — no custom glue.</li>
          <li>A2A tasks, messages, and streaming updates map onto Relay channels and threads automatically.</li>
          <li>Standard endpoints in, durable Relay delivery out, with the full chat history preserved.</li>
        </ul>
      </div>
    </FadeIn>
  );
}
