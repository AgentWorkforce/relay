`hicolor/scalable/apps/agent-relay.svg` is the mark (a copy of
`probe/resources/linux/agent-relay-mark.svg`) in a minimal `hicolor` theme for
builds from a checkout: `ui/mod.rs` adds this folder to GTK's icon search path
when no installed icon theme has `agent-relay`, so the taskbar shows the Agent
Relay mark instead of GTK's own icon. It has to be a themed icon: GTK builds a
window's icon list from the sizes the theme reports, and an unthemed icon
reports none. Packaged trees ship the icon under `share/icons/hicolor`;
`scripts/build-windows.sh` does not copy this folder.
