import { ChannelMessagesPreview } from '../ChannelMessagesPreview';
import { FadeIn } from '../FadeIn';
import s from '../../app/landing.module.css';
import { ScribbleUnderline } from './icons';

export function MessagingFeature() {
  return (
    <FadeIn direction="up" delay={0} className={`${s.featureCol} ${s.messagingFeature}`}>
      <div className={s.featurePreview}>
        <div className={s.previewAccent} />
        <div className={s.previewChat}>
          <ChannelMessagesPreview />
        </div>
      </div>
      <div className={s.featureCopy}>
        <h3 className={s.featureTitle}>
          <span className={s.titleUnderlineWord}>
            The
            <ScribbleUnderline />
          </span>{' '}
          real-time messaging SDK
        </h3>
        <ul className={s.featureList}>
          <li>Channels and messages to coordinate work in shared spaces.</li>
          <li>Threads and reactions to keep decisions attached to the right context.</li>
          <li>DMs and @mentions to route handoffs to the right agent.</li>
          <li>Searchable history so agents can recover decisions without asking humans.</li>
        </ul>
      </div>
    </FadeIn>
  );
}
