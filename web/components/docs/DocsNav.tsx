'use client';

import type { ComponentType, SVGProps } from 'react';
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Bot,
  Cloud,
  Clock3,
  Compass,
  FolderOpen,
  Hash,
  Mail,
  Plug,
  PlayCircle,
  Power,
  Rocket,
  Send,
  Shield,
  Smile,
  Terminal,
  Users,
  Workflow,
} from 'lucide-react';
import { BsChatRightText } from 'react-icons/bs';
import { FaReact } from 'react-icons/fa';
import { GrSwift } from 'react-icons/gr';
import { PiBroadcastFill } from 'react-icons/pi';
import { RiLayout5Line } from 'react-icons/ri';
import { SiClaude, SiPython, SiTypescript } from 'react-icons/si';

import { docsNav } from '../../lib/docs-nav';
import styles from './docs.module.css';

type NavIcon = ComponentType<SVGProps<SVGSVGElement>>;

const navIcons: Record<string, NavIcon> = {
  introduction: Compass,
  quickstart: Rocket,
  'spawning-an-agent': Bot,
  'sending-messages': Send,
  'event-handlers': Activity,
  channels: Hash,
  dms: Mail,
  threads: BsChatRightText,
  'emoji-reactions': Smile,
  'file-sharing': FolderOpen,
  authentication: Shield,
  scheduling: Clock3,
  'reference-workflows': Workflow,
  cloud: Cloud,
  workforce: Users,
  'relay-dashboard': RiLayout5Line,
  observer: PiBroadcastFill,
  'cli-overview': Terminal,
  'cli-broker-lifecycle': Power,
  'cli-agent-management': Bot,
  'cli-messaging': Send,
  'cli-workflows': Workflow,
  'cli-cloud-commands': Cloud,
  'cli-on-the-relay': Plug,
  'typescript-sdk': SiTypescript,
  'react-sdk': FaReact,
  'python-sdk': SiPython,
  'swift-sdk': GrSwift,
  'plugin-claude-code': SiClaude,
  'typescript-examples': PlayCircle,
};

export function DocsNav() {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const nav = navRef.current;
    const container = nav?.parentElement;
    const docsBody = container?.parentElement;

    if (!nav || !container || !docsBody) return;

    const restingTop = docsBody.getBoundingClientRect().top;

    const syncWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;

      const target = event.target;
      if (target instanceof Node && container.contains(target)) {
        return;
      }

      const scrollMax = container.scrollHeight - container.clientHeight;
      if (scrollMax <= 0) return;

      const docsBodyRect = docsBody.getBoundingClientRect();
      const atBoundary =
        event.deltaY > 0
          ? docsBodyRect.bottom <= window.innerHeight + 1
          : docsBodyRect.top >= restingTop - 1;

      if (!atBoundary) return;

      const nextScrollTop = Math.max(0, Math.min(scrollMax, container.scrollTop + event.deltaY));
      if (Math.abs(nextScrollTop - container.scrollTop) < 0.5) return;

      container.scrollTop = nextScrollTop;
    };

    window.addEventListener('wheel', syncWheel, { passive: true });

    return () => {
      window.removeEventListener('wheel', syncWheel);
    };
  }, []);

  return (
    <nav ref={navRef} className={styles.sidebar} aria-label="Documentation">
      {docsNav.map((group) => (
        <div key={group.title} className={styles.navGroup}>
          <h4 className={styles.navGroupTitle}>{group.title}</h4>
          <ul className={styles.navList}>
            {group.items.map((item) => {
              const href = `/docs/${item.slug}`;
              const isActive = pathname === href || (item.slug === 'introduction' && pathname === '/docs');
              const Icon = navIcons[item.slug];
              return (
                <li key={item.slug}>
                  <a
                    href={href}
                    className={`${styles.navLink} ${isActive ? styles.navLinkActive : ''}`}
                  >
                    {Icon && <Icon className={styles.navIcon} aria-hidden="true" />}
                    <span className={styles.navLabel}>{item.title}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
