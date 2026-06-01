export interface BlogAuthorProfile {
  name: string;
  title: string;
  image?: string;
  imageAlt?: string;
  social?: {
    linkedin?: string;
    x?: string;
    github?: string;
  };
}

const BLOG_AUTHORS: Record<string, BlogAuthorProfile> = {
  'Will Washburn': {
    name: 'Will Washburn',
    title: 'Co-founder, CEO',
    image: '/authors/will.png',
    imageAlt: 'Will Washburn',
    social: {
      linkedin: 'https://www.linkedin.com/in/willwashburn',
      x: 'https://x.com/willwashburn',
      github: 'https://github.com/willwashburn',
    },
  },
  'Khaliq Gant': {
    name: 'Khaliq Gant',
    title: 'Co-founder, CTO',
    image: '/authors/khaliq.jpeg',
    imageAlt: 'Khaliq Gant',
    social: {
      linkedin: 'https://www.linkedin.com/in/khaliqgant',
      x: 'https://x.com/khaliqgant',
      github: 'https://github.com/khaliqgant',
    },
  },
};

export function getBlogAuthor(name: string): BlogAuthorProfile {
  return (
    BLOG_AUTHORS[name] ?? {
      name,
      title: 'Agent Relay',
    }
  );
}

export function getAuthorInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2);
}
