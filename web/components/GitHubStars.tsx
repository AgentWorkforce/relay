'use client';

import { useEffect, useState } from 'react';

export function GitHubStars() {
  const [count, setCount] = useState<string | null>(null);

  useEffect(() => {
    fetch('https://api.github.com/repos/agentworkforce/relay')
      .then((r) => r.json())
      .then((data) => {
        const stars = data?.stargazers_count;
        if (typeof stars === 'number') {
          setCount(stars >= 1000 ? `${(stars / 1000).toFixed(1)}k` : String(stars));
        }
      })
      .catch(() => {});
  }, []);

  if (!count) return null;

  return <span>{count}</span>;
}
