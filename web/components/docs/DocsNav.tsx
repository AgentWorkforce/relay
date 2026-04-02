'use client';

import type { ComponentType, SVGProps } from 'react';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Bot,
  Cloud,
  Clock3,
  Code2,
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
import { GrSwift } from 'react-icons/gr';
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
  'cli-overview': Terminal,
  'cli-broker-lifecycle': Power,
  'cli-agent-management': Bot,
  'cli-messaging': Send,
  'cli-workflows': Workflow,
  'cli-cloud-commands': Cloud,
  'cli-on-the-relay': Plug,
  'reference-sdk': SiTypescript,
  'reference-sdk-py': SiPython,
  'swift-sdk': GrSwift,
  'plugin-claude-code': SiClaude,
  'typescript-examples': PlayCircle,
};

export function DocsNav() {
  const pathname = usePathname();

  return (
    <nav className={styles.sidebar} aria-label="Documentation">
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
