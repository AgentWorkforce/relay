Symbolic icons the app names that Adwaita 47 and later no longer ship
(`emblem-ok-symbolic`, `external-link-symbolic`,
`utilities-system-monitor-symbolic`). `scripts/build-windows.sh` installs them
into the zip's `share/icons/hicolor/symbolic/apps/` directory (the one symbolic directory hicolor's index.theme lists) so GTK finds them on
Windows; Linux takes them from the installed icon theme.
