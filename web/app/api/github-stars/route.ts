type GitHubRepoResponse = {
  stargazers_count?: number;
};

export const dynamic = 'force-dynamic';

function unavailable() {
  return new Response(null, {
    status: 204,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}

export async function GET() {
  try {
    const response = await fetch('https://api.github.com/repos/agentworkforce/relay', {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'agentrelay-web',
      },
      cache: 'no-store',
    });

    if (!response.ok) return unavailable();

    const data = (await response.json()) as GitHubRepoResponse;
    if (typeof data.stargazers_count !== 'number') return unavailable();

    return Response.json(
      { stargazers_count: data.stargazers_count },
      {
        headers: {
          'Cache-Control': 'public, max-age=300, s-maxage=300',
        },
      }
    );
  } catch {
    return unavailable();
  }
}
