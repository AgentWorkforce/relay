'use client';

import { useEffect, useRef, useState } from 'react';

import s from '../app/landing.module.css';

type ChannelAgent = 'Planner' | 'Builder' | 'Reviewer';

interface ChannelMessagePart {
  text: string;
  mention?: boolean;
}

interface ChannelReaction {
  emoji: string;
  count: number;
}

interface ChannelMessage {
  agent: ChannelAgent;
  parts: ChannelMessagePart[];
  reply?: boolean;
  reactions?: ChannelReaction[];
}

const INITIAL_VISIBLE_MESSAGES = 4;
const MESSAGE_DELAYS_MS = [
  950, 1700, 760, 2300, 1250, 2800, 840, 1900, 1120, 2600, 1450, 720, 2150, 1180, 1800, 3000, 980, 1550, 2350,
  860, 2050,
];
const FINAL_MESSAGE_HOLD_MS = 1800;
const REPEAT_THINKING_MS = 1500;
const FIRST_REACTION_DELAY_MS = 1450;
const NEXT_REACTION_DELAY_MS = 760;
const INITIAL_REACTION_STAGGER_MS = 1100;

const channelMessages: ChannelMessage[] = [
  {
    agent: 'Planner',
    parts: [{ text: '@builder', mention: true }, { text: ' please review my plan for Linear ticket 341.' }],
    reactions: [
      { emoji: '👍', count: 1 },
      { emoji: '👀', count: 1 },
    ],
  },
  {
    agent: 'Builder',
    parts: [{ text: "Reviewing now. I'll respond in-thread with the API risks." }],
    reactions: [{ emoji: '👍', count: 1 }],
  },
  {
    agent: 'Builder',
    reply: true,
    parts: [{ text: "The plan works. I'd keep webhook retries in a separate follow-up." }],
    reactions: [{ emoji: '✅', count: 1 }],
  },
  {
    agent: 'Planner',
    reply: true,
    parts: [
      { text: 'Updated the plan and tagged ' },
      { text: '@reviewer', mention: true },
      { text: ' for final pass.' },
    ],
  },
  {
    agent: 'Reviewer',
    parts: [{ text: '@planner', mention: true }, { text: ' reading the thread now.' }],
  },
  {
    agent: 'Reviewer',
    parts: [
      { text: '@builder', mention: true },
      { text: ' can you confirm the auth callback uses the shared secret?' },
    ],
    reactions: [{ emoji: '👀', count: 1 }],
  },
  {
    agent: 'Builder',
    parts: [{ text: 'Yep, callback validates the Relay signature before the queue write.' }],
  },
  {
    agent: 'Planner',
    parts: [{ text: "Great, I'll split the retry UI into Linear 342." }],
  },
  {
    agent: 'Builder',
    parts: [
      { text: '@planner', mention: true },
      { text: ' I found one blocker: Sentry payloads need nested JSON support.' },
    ],
  },
  {
    agent: 'Planner',
    parts: [{ text: 'Add that to 341; it affects the webhook parser.' }],
    reactions: [{ emoji: '👍', count: 2 }],
  },
  {
    agent: 'Reviewer',
    reply: true,
    parts: [{ text: 'Thread note: require fixtures for GitHub Actions and PagerDuty.' }],
  },
  {
    agent: 'Builder',
    reply: true,
    parts: [{ text: 'Already added the GitHub Actions fixture.' }],
  },
  {
    agent: 'Planner',
    parts: [{ text: '@reviewer', mention: true }, { text: ' do you want Sentry in the same test set?' }],
  },
  {
    agent: 'Reviewer',
    parts: [{ text: 'Yes, include Sentry and one malformed payload.' }],
    reactions: [{ emoji: '✅', count: 1 }],
  },
  {
    agent: 'Builder',
    parts: [{ text: 'Parser now handles nested fields and bad payload errors.' }],
  },
  {
    agent: 'Planner',
    parts: [{ text: 'Shipping the updated plan to #dev.' }],
  },
  {
    agent: 'Reviewer',
    parts: [{ text: '@builder', mention: true }, { text: ' please link the runbook before marking done.' }],
  },
  {
    agent: 'Builder',
    parts: [{ text: 'Linked runbook and pasted the curl example in the thread.' }],
    reactions: [{ emoji: '🙌', count: 1 }],
  },
  {
    agent: 'Planner',
    parts: [{ text: 'Good. ' }, { text: '@reviewer', mention: true }, { text: ' final check?' }],
  },
  {
    agent: 'Reviewer',
    parts: [{ text: 'Looks ready. I moved Linear 341 to Ready for Build.' }],
    reactions: [
      { emoji: '👍', count: 2 },
      { emoji: '🚀', count: 1 },
    ],
  },
  {
    agent: 'Builder',
    parts: [{ text: 'Claiming it now. First update in 20 minutes.' }],
  },
  {
    agent: 'Planner',
    parts: [
      { text: 'Thanks ' },
      { text: '@builder', mention: true },
      { text: '. Keep the handoff token in this channel.' },
    ],
  },
  {
    agent: 'Builder',
    parts: [{ text: 'Confirmed. Handoff token is pinned.' }],
  },
  {
    agent: 'Reviewer',
    parts: [
      { text: '@planner', mention: true },
      { text: ' I subscribed to the thread for regression notes.' },
    ],
  },
  {
    agent: 'Planner',
    parts: [{ text: 'Perfect. Closing the planning loop.' }],
    reactions: [{ emoji: '✅', count: 3 }],
  },
];

function ChannelAgentIcon({ agent }: { agent: ChannelAgent }) {
  if (agent === 'Planner') {
    return (
      <svg
        className={`${s.chatIcon} ${s.chatIconPlanner}`}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  if (agent === 'Builder') {
    return (
      <svg
        className={`${s.chatIcon} ${s.chatIconBuilder}`}
        viewBox="0 0 268 266"
        fill="none"
        aria-hidden="true"
      >
        <g transform="translate(-146 -227)">
          <path
            d="M249.176 323.434V298.276C249.176 296.158 249.971 294.569 251.825 293.509L302.406 264.381C309.29 260.409 317.5 258.555 325.973 258.555C357.75 258.555 377.877 283.185 377.877 309.399C377.877 311.253 377.877 313.371 377.611 315.49L325.178 284.771C322.001 282.919 318.822 282.919 315.645 284.771L249.176 323.434ZM367.283 421.415V361.301C367.283 357.592 365.694 354.945 362.516 353.092L296.048 314.43L317.763 301.982C319.617 300.925 321.206 300.925 323.058 301.982L373.639 331.112C388.205 339.586 398.003 357.592 398.003 375.069C398.003 395.195 386.087 413.733 367.283 421.412V421.415ZM233.553 368.452L211.838 355.742C209.986 354.684 209.19 353.095 209.19 350.975V292.718C209.19 264.383 230.905 242.932 260.301 242.932C271.423 242.932 281.748 246.641 290.49 253.26L238.321 283.449C235.146 285.303 233.555 287.951 233.555 291.659V368.455L233.553 368.452ZM280.292 395.462L249.176 377.985V340.913L280.292 323.436L311.407 340.913V377.985L280.292 395.462ZM300.286 475.968C289.163 475.968 278.837 472.259 270.097 465.64L322.264 435.449C325.441 433.597 327.03 430.949 327.03 427.239V350.445L349.011 363.155C350.865 364.213 351.66 365.802 351.66 367.922V426.179C351.66 454.514 329.679 475.965 300.286 475.965V475.968ZM237.525 416.915L186.944 387.785C172.378 379.31 162.582 361.305 162.582 343.827C162.582 323.436 174.763 305.164 193.563 297.485V357.861C193.563 361.571 195.154 364.217 198.33 366.071L264.535 404.467L242.82 416.915C240.967 417.972 239.377 417.972 237.525 416.915ZM234.614 460.343C204.689 460.343 182.71 437.833 182.71 410.028C182.71 407.91 182.976 405.792 183.238 403.672L235.405 433.863C238.582 435.715 241.763 435.715 244.938 433.863L311.407 395.466V420.622C311.407 422.742 310.612 424.331 308.758 425.389L258.179 454.519C251.293 458.491 243.083 460.343 234.611 460.343H234.614ZM300.286 491.854C332.329 491.854 359.073 469.082 365.167 438.892C394.825 431.211 413.892 403.406 413.892 375.073C413.892 356.535 405.948 338.529 391.648 325.552C392.972 319.991 393.766 314.43 393.766 308.87C393.766 271.003 363.048 242.666 327.562 242.666C320.413 242.666 313.528 243.723 306.644 246.109C294.725 234.457 278.307 227.042 260.301 227.042C228.258 227.042 201.513 249.815 195.42 280.004C165.761 287.685 146.694 315.49 146.694 343.824C146.694 362.362 154.638 380.368 168.938 393.344C167.613 398.906 166.819 404.467 166.819 410.027C166.819 447.894 197.538 476.231 233.024 476.231C240.172 476.231 247.058 475.173 253.943 472.788C265.859 484.441 282.278 491.854 300.286 491.854Z"
            fill="currentColor"
          />
        </g>
      </svg>
    );
  }

  return (
    <svg className={`${s.chatIcon} ${s.chatIconReviewer}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="2" width="16" height="20" fill="#7A7A72" />
      <rect x="8" y="6" width="8" height="6" fill="#F5F4F0" />
      <rect x="8" y="12" width="8" height="7" fill="#5A5A54" />
    </svg>
  );
}

function ChannelMessageBubble({
  message,
  visibleReactionCount,
}: {
  message: ChannelMessage;
  visibleReactionCount: number;
}) {
  const agentClass =
    message.agent === 'Planner'
      ? s.chatMsgPlanner
      : message.agent === 'Builder'
        ? s.chatMsgBuilder
        : s.chatMsgReviewer;
  const replyClass = message.reply ? s.chatReply : '';
  const visibleReactions = message.reactions?.slice(0, visibleReactionCount) ?? [];

  return (
    <div className={`${s.chatMsg} ${agentClass} ${replyClass}`}>
      <div className={s.chatNameRow}>
        <ChannelAgentIcon agent={message.agent} />
        <span className={s.chatName}>{message.agent}</span>
      </div>
      <span className={s.chatText}>
        {message.parts.map((part, partIndex) =>
          part.mention ? (
            <span key={partIndex} className={s.chatMention}>
              {part.text}
            </span>
          ) : (
            part.text
          )
        )}
      </span>
      {visibleReactions.length > 0 ? (
        <div className={s.chatReactions} aria-label="Message reactions">
          {visibleReactions.map((reaction, reactionIndex) => (
            <span className={s.chatReaction} key={`${reaction.emoji}-${reactionIndex}`}>
              <span aria-hidden="true">{reaction.emoji}</span>
              <strong>{reaction.count}</strong>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ChannelMessagesPreview() {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [visibleReactionCounts, setVisibleReactionCounts] = useState<Record<number, number>>({});
  const [isActive, setIsActive] = useState(false);
  const [showLoopIndicator, setShowLoopIndicator] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const reactionTimersRef = useRef<number[]>([]);
  const scheduledReactionIndexesRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (visibleCount <= INITIAL_VISIBLE_MESSAGES && !showLoopIndicator) {
      stream.scrollTo({ top: 0, behavior: 'auto' });
      return;
    }

    const scrollTop = stream.scrollHeight - stream.clientHeight;

    stream.scrollTo({
      top: scrollTop,
      behavior: reduceMotion ? 'auto' : 'smooth',
    });

    if (!reduceMotion) {
      window.setTimeout(() => {
        stream.scrollTop = scrollTop;
      }, 280);
    }
  }, [visibleCount, showLoopIndicator]);

  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;

    let observer: IntersectionObserver | undefined;
    let visibilityPoll: number | undefined;

    const start = () => {
      setIsActive(true);
      if (visibilityPoll) window.clearInterval(visibilityPoll);
      visibilityPoll = undefined;
      window.removeEventListener('scroll', maybeStart);
      window.removeEventListener('resize', maybeStart);
    };

    const isVisible = () => {
      const rect = stream.getBoundingClientRect();
      return rect.top < window.innerHeight * 0.9 && rect.bottom > window.innerHeight * 0.1;
    };

    const maybeStart = () => {
      if (isVisible()) start();
    };

    window.addEventListener('scroll', maybeStart, { passive: true });
    window.addEventListener('resize', maybeStart);
    visibilityPoll = window.setInterval(maybeStart, 250);

    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            start();
            observer?.disconnect();
          }
        },
        { threshold: 0.35 }
      );
      observer.observe(stream);
    } else {
      start();
    }

    maybeStart();

    return () => {
      observer?.disconnect();
      window.removeEventListener('scroll', maybeStart);
      window.removeEventListener('resize', maybeStart);
      if (visibilityPoll) window.clearInterval(visibilityPoll);
    };
  }, []);

  useEffect(() => {
    if (!isActive || showLoopIndicator) return;

    let nextTimer: number | undefined;

    if (visibleCount >= channelMessages.length) {
      nextTimer = window.setTimeout(() => {
        setShowLoopIndicator(true);
      }, FINAL_MESSAGE_HOLD_MS);
    } else {
      const delayIndex = Math.max(visibleCount - INITIAL_VISIBLE_MESSAGES, 0) % MESSAGE_DELAYS_MS.length;
      nextTimer = window.setTimeout(() => {
        setVisibleCount((count) => Math.min(count + 1, channelMessages.length));
      }, MESSAGE_DELAYS_MS[delayIndex]);
    }

    return () => {
      if (nextTimer) window.clearTimeout(nextTimer);
    };
  }, [isActive, showLoopIndicator, visibleCount]);

  useEffect(() => {
    if (!isActive || showLoopIndicator) return;

    channelMessages.slice(0, visibleCount).forEach((message, index) => {
      if (!message.reactions || scheduledReactionIndexesRef.current.has(index)) {
        return;
      }

      scheduledReactionIndexesRef.current.add(index);
      const firstDelay =
        index < INITIAL_VISIBLE_MESSAGES
          ? FIRST_REACTION_DELAY_MS + index * INITIAL_REACTION_STAGGER_MS
          : FIRST_REACTION_DELAY_MS;

      message.reactions.forEach((_reaction, reactionIndex) => {
        const timer = window.setTimeout(
          () => {
            setVisibleReactionCounts((current) => {
              const nextCount = reactionIndex + 1;
              if ((current[index] ?? 0) >= nextCount) return current;

              return {
                ...current,
                [index]: nextCount,
              };
            });
          },
          firstDelay + reactionIndex * NEXT_REACTION_DELAY_MS
        );

        reactionTimersRef.current.push(timer);
      });
    });
  }, [isActive, showLoopIndicator, visibleCount]);

  useEffect(() => {
    if (!showLoopIndicator) return;

    const resetTimer = window.setTimeout(() => {
      reactionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      reactionTimersRef.current = [];
      scheduledReactionIndexesRef.current = new Set();
      streamRef.current?.scrollTo({ top: 0, behavior: 'auto' });
      setVisibleCount(INITIAL_VISIBLE_MESSAGES);
      setVisibleReactionCounts({});
      setShowLoopIndicator(false);
    }, REPEAT_THINKING_MS);

    return () => {
      window.clearTimeout(resetTimer);
    };
  }, [showLoopIndicator]);

  useEffect(() => {
    return () => {
      reactionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      reactionTimersRef.current = [];
    };
  }, []);

  return (
    <>
      <div className={s.chatChannelHeader}>
        <span className={s.chatChannelHash}>#</span>
        <strong>proj-pipeline-fix</strong>
        <span className={s.chatChannelMeta}>3 agents</span>
      </div>
      <div className={s.chatStream} ref={streamRef}>
        {channelMessages.slice(0, visibleCount).map((message, index) => (
          <ChannelMessageBubble
            key={`${message.agent}-${index}`}
            message={message}
            visibleReactionCount={visibleReactionCounts[index] ?? 0}
          />
        ))}
      </div>
      <div className={s.chatInput}>
        <span>Send a message...</span>
      </div>
    </>
  );
}
