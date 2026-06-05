// Stable, public download link for the latest Pear build (macOS, Apple Silicon).
//
// Redirects to the newest published asset in the PUBLIC AgentWorkforce/pear-releases
// repo, so we can hand out a single branded URL that always points at the current
// release without exposing the private `pear` source repo:
//
//   wget --content-disposition https://origin.agentrelay.net/pear/download
//
// The binary is mirrored into pear-releases by the pear repo's "mirror-release"
// workflow whenever a GitHub Release is published. GitHub resolves `latest`
// server-side, so this redirect target is constant.
const LATEST_DMG = 'https://github.com/AgentWorkforce/pear-releases/releases/latest/download/Pear-arm64.dmg';

export function GET() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: LATEST_DMG,
      // Short cache: keep the link snappy without pinning it across a release.
      'Cache-Control': 'public, max-age=300',
    },
  });
}
