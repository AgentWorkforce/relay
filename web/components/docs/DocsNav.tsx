'use client';

import type { ComponentType, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Bot,
  ChevronRight,
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
import { PiBroadcastFill, PiLockKeyDuotone } from 'react-icons/pi';
import { RiLayout5Line } from 'react-icons/ri';
import { SiClaude, SiPython, SiTypescript } from 'react-icons/si';

import { docsNav, type NavItem } from '../../lib/docs-nav';
import styles from './docs.module.css';

type NavIcon = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;

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
  permissions: PiLockKeyDuotone,
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

export function DocsNav({ variant = 'sidebar' }: { variant?: 'sidebar' | 'mobileMenu' } = {}) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement | null>(null);
  const isSidebar = variant === 'sidebar';

  useEffect(() => {
    if (!isSidebar) return;

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
        event.deltaY > 0 ? docsBodyRect.bottom <= window.innerHeight + 1 : docsBodyRect.top >= restingTop - 1;

      if (!atBoundary) return;

      const nextScrollTop = Math.max(0, Math.min(scrollMax, container.scrollTop + event.deltaY));
      if (Math.abs(nextScrollTop - container.scrollTop) < 0.5) return;

      container.scrollTop = nextScrollTop;
    };

    window.addEventListener('wheel', syncWheel, { passive: true });

    return () => {
      window.removeEventListener('wheel', syncWheel);
    };
  }, [isSidebar]);

  return (
    <nav
      ref={navRef}
      className={`${styles.sidebar} ${!isSidebar ? styles.mobileSidebar : ''}`}
      aria-label="Documentation"
    >
      {docsNav.map((group) => (
        <div key={group.title} className={styles.navGroup}>
          <h4 className={styles.navGroupTitle}>{group.title}</h4>
          <ul className={styles.navList}>
            {group.items.map((item) => (
              <NavItemRow key={item.slug} item={item} pathname={pathname} />
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function isLinkActive(slug: string, pathname: string): boolean {
  return pathname === `/docs/${slug}` || (slug === 'introduction' && pathname === '/docs');
}

function containsActive(item: NavItem, pathname: string): boolean {
  if (isLinkActive(item.slug, pathname)) return true;
  return item.children?.some((child) => containsActive(child, pathname)) ?? false;
}

function NavItemRow({ item, pathname }: { item: NavItem; pathname: string }): ReactElement {
  const href = `/docs/${item.slug}`;
  const isActive = isLinkActive(item.slug, pathname);
  const Icon = navIcons[item.slug];
  const hasChildren = Boolean(item.children && item.children.length > 0);

  // Collapsed by default; auto-expanded if the current page is in this
  // item's subtree so users don't lose their bearings when navigating.
  const activeInSubtree = hasChildren && containsActive(item, pathname);
  const [open, setOpen] = useState(activeInSubtree);

  // Re-sync open state when the pathname changes (e.g. nav click).
  useEffect(() => {
    if (activeInSubtree) setOpen(true);
  }, [activeInSubtree]);

  if (!hasChildren) {
    return (
      <li>
        <a href={href} className={`${styles.navLink} ${isActive ? styles.navLinkActive : ''}`}>
          {Icon && <Icon className={styles.navIcon} aria-hidden="true" />}
          <span className={styles.navLabel}>{item.title}</span>
        </a>
      </li>
    );
  }

  const childListId = `nav-children-${item.slug}`;
  return (
    <li>
      <div className={styles.navLinkRow}>
        <a href={href} className={`${styles.navLink} ${isActive ? styles.navLinkActive : ''}`}>
          {Icon && <Icon className={styles.navIcon} aria-hidden="true" />}
          <span className={styles.navLabel}>{item.title}</span>
        </a>
        <button
          type="button"
          className={`${styles.navToggle} ${open ? styles.navToggleOpen : ''}`}
          aria-expanded={open}
          aria-controls={childListId}
          aria-label={open ? `Collapse ${item.title}` : `Expand ${item.title}`}
          onClick={() => setOpen((prev) => !prev)}
        >
          <ChevronRight className={styles.navToggleIcon} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <ul id={childListId} className={`${styles.navList} ${styles.navChildren}`}>
          {item.children!.map((child) => (
            <NavItemRow key={child.slug} item={child} pathname={pathname} />
          ))}
        </ul>
      )}
    </li>
  );
}
