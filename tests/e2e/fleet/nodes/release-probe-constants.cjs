'use strict';

// Shared by the executable probe and its process/roster assertions. Keeping
// the filename in one module prevents a fixture rename from silently turning
// the absence check into a stale-file timeout.
module.exports = {
  RELEASE_PROBE_PID_FILE: 'release-1671-descendant.pid',
};
