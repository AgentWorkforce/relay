// Stable, public download link for the latest Pear build (macOS, Apple Silicon).
//
// Redirects to the newest published installer on the public AgentWorkforce/pear
// repo. electron-builder publishes the DMG under a fixed filename
// (`pear-arm64.dmg`), so GitHub's `releases/latest/download/<name>` URL — which
// resolves "latest" server-side — is a constant target:
//
//   wget --content-disposition https://origin.agentrelay.net/pear/download
const LATEST_DMG = 'https://github.com/AgentWorkforce/pear/releases/latest/download/pear-arm64.dmg';

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
